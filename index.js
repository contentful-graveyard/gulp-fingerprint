'use strict';

var chalk = require('chalk');
var gutil = require('gulp-util');
var path = require('path');
var split = require('split2');
var through = require('through2');
var SourceMapGenerator = require('source-map').SourceMapGenerator;
var SourceMapConsumer  = require('source-map').SourceMapConsumer;


var PLUGIN_NAME = 'gulp-fingerprint';

/**
 * Gulp Plugin to stream through a file and rename regex matches
 *
 * @param {Object} manifest - rev-manifest
 * @param {Object} options
 */
var plugin = function(manifest, options) {
  options = options || {};

  // Default regex to allow for single and double quotes
  // var regex = new RegExp('url\\("(.*)"\\)|src="(.*)"|href="(.*)"|url\\(\'(.*)\'\\)|src=\'(.*)\'|href=\'(.*)\'', 'g');
  var regex = /(?:url\(["']?(.*?)['"]?\)|src=["'](.*?)['"]|src=([^\s\>]+)(?:\>|\s)|href=["'](.*?)['"]|href=([^\s\>]+)(?:\>|\s))/g;
  var prefix = '';
  var base = '';
  var strip = '';
  var mode = 'regex';
  var content = [];

  // Use custom RegExp
  if (options.regex) regex = options.regex;

  if (options.prefix) prefix = options.prefix;

  if (options.base) base = options.base.replace(/^\//, '');

  if (options.strip) strip = options.strip.replace(/^\//, '');

  if (options.mode === 'replace') {
    mode = 'replace';
  }

  if (strip) {
    var stripRegex = new RegExp('^\/' + strip + '|^' + strip);
  }

  if (base) {
    var baseRegex = new RegExp('^\/' + base + '|^' + base);
  }

  if (typeof(manifest) === 'string') {
    manifest = require(path.resolve(manifest));
  }

  function regexMode(buf, enc, cb) {
    var line = buf.toString();
    var replacements = [];
    var shift = 0;

    line = line.replace(regex, function(str, i) {
      var originalMatch = str;
      var offset = arguments[arguments.length-2];
      var url = Array.prototype.slice.call(arguments, 1).filter(function(a) {return a;})[0];
      if (options.verbose) gutil.log(PLUGIN_NAME, 'Found:', chalk.yellow(url.replace(/^\//, '')));
      var replaced = manifest[url] || manifest[url.replace(/^\//, '')] || manifest[url.split(/[#?]/)[0]];
      if (!replaced && base) replaced = manifest[url.replace(baseRegex, '')];
      if (replaced) {
        if (strip) {
          replaced = replaced.replace(stripRegex, '');
        }
        str = str.replace(url, prefix + replaced);
        replacements.push({
          original:  offset,
          generated: offset + shift
        });
        replacements.push({
          original:  offset + originalMatch.length,
          generated: offset + shift + str.length
        });
        shift = shift + (str.length - originalMatch.length);
      }
      if (options.verbose) gutil.log(PLUGIN_NAME, 'Replaced:', chalk.green(prefix + replaced));
      return str;
    });

    content.push([line, replacements]);
    cb();
  }

  function replaceMode(buf, enc, cb) {
    var line = buf.toString();

    base = base.replace(/(^\/|\/$)/g, '');

    var replacements = [];
    function lastReplacement(a) {
      var i = a[a.length-1];
      return i || {original: 0, generated: 0};
    }

    for (var url in manifest) {
      var dest = manifest[url], replaced, bases;
      if (strip) {
        replaced = prefix + dest.replace(stripRegex, '');
      } else {
        replaced = prefix + dest;
      }
      bases = ['/', ''];
      if (base) {
        bases.unshift('/' + base + '/', base + '/');
      }
      for (var i = 0; i < bases.length; i++) {
        var replacementsForBase = [];
        var currentUrl = bases[i] + url;
        var tokens = line.split(currentUrl);
        for (var j=1; j < tokens.length; j++) {
          replacementsForBase.push({
            original:  lastReplacement(replacementsForBase).original  + tokens[j-1].length,
            generated: lastReplacement(replacementsForBase).generated + tokens[j-1].length
          });
          replacementsForBase.push({
            original:  lastReplacement(replacementsForBase).original  + currentUrl.length,
            generated: lastReplacement(replacementsForBase).generated + replaced.length
          });
        }

        var newLine = line.split(currentUrl).join(replaced);
        if (line !== newLine) {
          if (options.verbose) gutil.log(PLUGIN_NAME, 'Found:', chalk.yellow(url.replace(/^\//, '')));
          if (options.verbose) gutil.log(PLUGIN_NAME, 'Replaced:', chalk.green(prefix + replaced));
          line = newLine;
          replacements.push.apply(replacements, replacementsForBase);
          break;
        }
      }
    }

    content.push([line, replacements]);
    cb();
  }

  var stream = through.obj(function(file, enc, cb) {
    var that = this;
    content = []; // reset file content

    if (file.isNull()) {
      this.push(file);
      return cb();
    }

    if (file.isStream()) {
      this.emit('error', new gutil.PluginError(PLUGIN_NAME, 'Streaming not supported'));
      return cb();
    }

    if (file.isBuffer()) {
      var oldContent = file.contents.toString();
      file.pipe(split())
      .pipe(through(mode === 'regex' ? regexMode : replaceMode,  function(callback) {
        if (content.length) {
          var stringContent = content.map(function(x){return x[0];});
          file.contents = new Buffer(stringContent.join('\n'));

          if (file.sourceMap) {
            var map;
            if (file.sourceMap.mappings) {
              var sourceMap = file.sourceMap;
              if (!sourceMap.file) {
                sourceMap.file = file.relative;
              }
              var consumer  = new SourceMapConsumer(sourceMap);
              map = SourceMapGenerator.fromSourceMap(consumer);
            } else {
              map = new SourceMapGenerator({ file: file.relative });
              map.setSourceContent(file.relative, oldContent);
            }

            var replacements = content.map(function(x) { return x[1]; });
            replacements.forEach(function(line, lineNo){
              line.forEach(function(mapping){
                map.addMapping({
                  // Source Map line numbers are 1-based
                  original:  {line: lineNo + 1, column: mapping.original},
                  generated: {line: lineNo + 1, column: mapping.generated},
                  source: map._file
                });
              });
            });
            map.applySourceMap(consumer);
            file.sourceMap = map.toJSON();
          }
          that.push(file);
        }
        cb();
      }));
    }

  });

  return stream;
};

module.exports = plugin;
