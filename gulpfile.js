var tsc = require('gulp-typescript');
var gulp = require('gulp');
var path = require('path');
var es = require('event-stream');
var concat = require('gulp-concat');

gulp.task('compile', function () {
	return (
		gulp.src([
			'src/**/*.ts'
		])
		.pipe(tsc({
			target: 'es5',
			module: 'commonjs'
      }))
		.js
		.pipe(gulp.dest('./out'))
	);
});

gulp.task('bundle', ['compile'], function () {
	var tests = gulp.src(['out/tests/tests.js'], {base: 'out'});
	var main = (
		gulp.src([
			'out/_prefix.js',
			'out/utils.js',
			'out/matcher.js',
			'out/plistParser.js',
			'out/grammarReader.js',
			'out/rule.js',
			'out/grammar.js',
			'out/registry.js',
			'out/main.js',
			'out/_suffix.js',
		])
		.pipe(
			es.through(
				function(data) {
					if (!/_prefix|_suffix/.test(data.path)) {
						var path = './' + data.path.substr(data.base.length).replace(/\.js$/, '');
						var prefix = "$load('" + path + "', function(require, module, exports) {\n";
						var suffix = '\n});'

						data.contents = Buffer.concat([
							new Buffer(prefix),
							data.contents,
							new Buffer(suffix)
						]);
					}

					this.emit('data', data);
				},
				function() {
					this.emit('end');
				}
			)
		)
		.pipe(concat('main.js'))
	);
	var dts = (
		gulp.src([
			'src/typings/main.d.ts'
		])
	);
	return (
		es.merge(
			main,
			tests,
			dts
		)
		.pipe(gulp.dest('./release'))
	);
});

gulp.task('watch', ['bundle'], function () {
	gulp.watch([
		'src/**/*.ts'
	], ['bundle']);
});

gulp.task('test', function () {
	var tests = require('./scripts/tests.js');
	tests.runTests();
});
