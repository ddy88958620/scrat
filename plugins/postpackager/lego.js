'use strict';

var vm = require('vm');
var jsdom = require('jsdom').jsdom;
var LINK_PROPS_RE = /\s([a-z-]+)\s*=\s*"([^"]+)"/g;

function wrapJSMod(content, file) {
    if (file.rExt !== '.js') return content;
    var pre = 'define("' + file.getId() + '",function(require,exports,module){';
    var post = '});';
    return pre + content + post;
}

// 通过指定 id 获取文件对象
function getFile(id, ext, files) {
    // 不是别名直接返回
    var f = files.ids[id];
    if (f) return f;

    // 查别名表
    var alias = fis.config.get('lego.alias');
    id = alias && alias[id] || id;
    f = files.ids[id];
    if (f) return f;

    // 别名不带后缀名
    id += '/' + id.split('/').slice(-1)[0] + ext;
    f = files.ids[id];
    if (f) return f;

    // 尝试相似类型后缀名
    var looksLike = {
        '.css': '.styl',
        '.styl': '.css'
    };

    if (looksLike.hasOwnProperty(ext)) {
        id = id.replace(ext, looksLike[ext]);
        f = files.ids[id];
        if (f) return f;
    }
}

function getDeps(file, files, appendSelf, deps) {
    appendSelf = appendSelf !== false;
    deps = deps || {css: {}, js: {}};

    file.requires.forEach(function (id) {
        var f = getFile(id, file.ext, files);
        if (!f) fis.log.warning('module [' + id + '] not found');
        else getDeps(f, files, true, deps);
    });

    var prefix = '/lego/' + fis.config.get('lego.code') + '/';
    var id = file.release.replace(prefix, '').replace(file.rExt, '');
    if (appendSelf && deps[file.rExt.slice(1)] &&
        !deps[file.rExt.slice(1)][id]) deps[file.rExt.slice(1)][id] = 1;

    return {css: Object.keys(deps.css), js: Object.keys(deps.js)};
}

module.exports = function (ret, conf, settings, opt) {
    var lego = fis.config.get('lego');
    var map = {
        code: lego.code,
        views: [],
        units: []
    };
    var units = {};

    fis.util.map(ret.src, function (subpath, file) {
        // 包装符合要求的 JS 文件
        if (file.isMod && file.isJsLike) {
            file.setContent(wrapJSMod(file.getContent(), file));
        }

        if (file.isView) {
            var doc = jsdom(file.getContent());
            var obj = {
                head: {
                    metas: [],
                    styles: [],
                    scripts: []
                },
                body: {
                    units: [],
                    styles: [],
                    scripts: []
                }
            };

            // 解析 head，提取 META、TITLE 及非组件化资源
            fis.util.map(doc.head.children, function (_, el) {
                switch (el.tagName) {
                case 'META':
                    if (el.name) {
                        obj.head.metas.push({
                            name: el.name,
                            content: el.content
                        });
                    }
                    break;
                case 'TITLE':
                    obj.head.title = el.innerHTML;
                    break;
                case 'LINK':
                    if (el.rel === 'stylesheet') {
                        obj.head.styles.push({
                            url: el.href
                        });
                    }
                    break;
                case 'STYLE':
                    obj.head.styles.push({
                        content: el.innerHTML
                    });
                    break;
                case 'SCRIPT':
                    if (el.src) {
                        obj.head.scripts.push({
                            url: el.src
                        });
                    } else {
                        obj.head.scripts.push({
                            content: el.innerHTML
                        });
                    }
                    break;
                }
            });

            // 解析 body，提取布局、单元及非组件化资源
            fis.util.map(doc.body.children, function (_, el) {
                switch (el.tagName) {
                case 'LINK':
                    switch (el.rel) {
                    case 'layout':
                        // TODO 此处只是提取布局配置，暂不实现布局支持
                        var html = el.outerHTML;
                        el = {};
                        while (LINK_PROPS_RE.exec(html)) {
                            el[RegExp.$1] = RegExp.$2;
                        }
                        if (el.name) {
                            delete el.rel;
                            el.code = lego.code + '_layout_' + el.name;
                            obj.body.layouts.push(el);
                        }
                        break;
                    case 'unit':
                        var html = el.outerHTML;
                        el = {};
                        while (LINK_PROPS_RE.exec(html)) {
                            el[RegExp.$1] = RegExp.$2;
                        }
                        if (el.name) {
                            delete el.rel;
                            el.code = lego.code + '_unit_' + el.name;
                            obj.body.units.push(el);
                        }
                        break;
                    case 'stylesheet':
                        obj.body.styles.push({
                            url: el.href
                        });
                        break;
                    }
                    break;
                case 'STYLE':
                    obj.body.styles.push({
                        content: el.innerHTML
                    });
                    break;
                case 'SCRIPT':
                    if (el.src) {
                        obj.body.scripts.push({
                            url: el.src
                        });
                    } else {
                        obj.body.scripts.push({
                            content: el.innerHTML
                        });
                    }
                    break;
                }
            });

            map.views.push(obj);
            delete ret.src[file.subpath];
            file.release = false;
        } else if (file.isUnit) {
            // 与目录同名的 ejs、js、css 文件都可以成为单元
            var obj = units[file.filename];
            if (!obj) {
                obj = units[file.filename] = {
                    name: file.filename,
                    code: lego.code + '_unit_' + file.filename
                };
                map.units.push(obj);
            }

            if (file.isHtmlLike) {
                obj.source = file.getContent();
                var data = ret.src[file.subdirname + '/data.js'];
                if (data) {
                    var sandbox = {module: {}};
                    var code = 'var exports=module.exports={};' + data.getContent();
                    try {
                        vm.runInNewContext(code, sandbox);
                        obj.data = JSON.stringify(sandbox.module.exports);
                    } catch (e) {
                        fis.log.error('[' + data.getId() + '] is illegal: ' + e.message);
                        obj.data = {};
                    }
                    delete ret.src[data.subpath];
                    data.release = false;
                } else {
                    obj.data = {};
                }
                // 以 HTML 为单元入口计算依赖
                delete obj.css;
                delete obj.js;
                obj = fis.util.merge(obj, getDeps(file, ret));

                delete ret.src[file.subpath];
                file.release = false;
            } else if (file.isCssLike && !obj.source && !obj.js) {
                // 单元无 HTML 入口和 JS 入口，以 CSS 为入口计算依赖
                obj = fis.util.merge(obj, getDeps(file, ret));
            } else if (file.isJsLike && !obj.source) {
                // 单元无 HTML 入口，以 JS 为入口计算依赖
                delete obj.css;
                obj = fis.util.merge(obj, getDeps(file, ret));
            }

            var thumb = ret.src[file.subdirname + '/thumb.png'];
            if (thumb) obj.thumb = opt.md5 ? thumb.getHashRelease() : thumb.release;
        } else if (file.isOther && opt.dest !== 'preview') {
            delete ret.src[file.subpath];
            file.release = false;
        }
    });

    var file = fis.file(fis.project.getProjectPath('release.json'));
    file.setContent(JSON.stringify(map, null, 2));
    file.compiled = true;
    ret.pkg[file.subpath] = file;
};