'use strict';

// Calls the shared matrix probe (runner.js and logic.js are copied next to this
// file by scripts/run-scenario.sh, unchanged from test/extension-matrix/probe).
// The probe writes its own result file; this wrapper only reports a crash.
const fs = require('fs');

exports.activate = function activate() {
	if (!process.env.AXIS_MATRIX_SCENARIO_FILE || !process.env.AXIS_MATRIX_RESULT) {
		return;
	}
	// Do not block activation; checks run after startup has finished.
	setTimeout(() => {
		require('./runner').run().catch(err => {
			const marker = process.env.AXIS_MATRIX_RESULT + '.error';
			fs.writeFileSync(marker, String((err && err.stack) || err) + '\n');
		});
	}, 1000);
};

exports.deactivate = function deactivate() {};
