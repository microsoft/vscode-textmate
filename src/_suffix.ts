
declare var define: any;
if (typeof define === 'function' && define.amd) {
	// define(['require', 'exports'], factory);
} else {
	module.exports = $map['./main'].exports;
}