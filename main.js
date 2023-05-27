'use strict';
/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const net = require('net');
const idcCore = require('./lib/idc-core.js');
//
class Deyeidc extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'deyeidc',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
		//
		this.idc = new idcCore();
		this.client = new net.Socket();
		this.client.setTimeout(20000);	//deactiviert
		// because [W505] setTimeout found in "main.js", but no clearTimeout detected in AdapterCheck
		// -----------------  Timeout variables -----------------
		this.sync_milliseconds = 60000; // 1min
		// -----------------  Global variables -----------------
		this.connectionActive = false;
		this.internDataReady = true;
		this.numberRegisterSets = 0;
		this.numberCoils = 0;
		this.counter = 0;
		this.req = 0;
		this.CalcValues = [];
		this.setWatchPoints = false;
		this.resetCounter = 0;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Reset the connection indicator during startup
		this.setState('info.connection', false, true);
		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:

		// Initialize your adapter Here
		// About User changes
		await this.checkUserData();

		// Loading the Register
		try {
			const RegisterSets = this.config.registers;
			if (RegisterSets && Array.isArray(RegisterSets)) {
				this.numberRegisterSets = RegisterSets.length;
				this.idc.setRegisters(RegisterSets);
			}
		} catch (err) {
			this.internDataReady = false;
			this.log.error(`[readRegisterset] ${err}`);
		}
		//
		// Loading the Coils
		try {
			const Coils = this.config.coils;
			if (Coils && Array.isArray(Coils)) {
				this.numberCoils = Coils.length;
				this.idc.setCoils(Coils);
			}
		} catch (err) {
			this.internDataReady = false;
			this.log.error(`[readCoilset] ${err}`);
		}

		if (this.internDataReady) {
			// Start connection handler to created & monitor websocket connection
			await this.connectionHandler();
			// request
			await this.requestData();
			// subscribe Contraol
			this.subscribeStates(this.config.logger + '.' + 'Control.PowerSet');
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state) {
			// The state was changed
			//this.log.debug(`state ${id} has changed to ${state.val}`);
			if (id.indexOf('Power_Set') > 1) {
				await this.setPower(id, state);
			} else {
				this.updateData(await this.computeData(id, state));
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	/**
	 * connection to inverter
	 */
	connect() {
		this.log.debug(`try to connect . . .`);
		this.client.connect({ host: this.config.ipaddress, port: this.config.port });
	}

	/**
	 * connectionHandler
	 */
	async connectionHandler() {
		this.client.on('connect', () => {
			this.log.debug(`connected`);
			this.connectionActive = true;
			this.resetCounter = 0;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('timeout', () => {
			this.log.debug(`timeout`);
			this.client.destroy();
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('error', (err) => {
			this.client.destroy();
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
			if (err) this.log.debug(`Error during connection ${err.message}`);
			// Counter for PowerReset
			this.powerReset(err);
		});

		this.client.on('end', () => {
			this.log.debug(`Connection to server terminated`);
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('data', (data) => {
			if (this.req < this.numberRegisterSets) {
				try {
					//console.log(`${this.idc.toHexString(data)}`);
					this.mb = this.idc.checkDataFrame(data);
					this.createDPsForInstances();
				} catch (err) {
					this.log.error(`${err}`);
				}

				// Preparation of the data
				if (this.mb) {
					this.updateData(this.idc.readCoils(this.mb));
				}

				// send next request
				if (data.length > 0) {
					this.req++;
					this.sendRequest(this.req);
				}
			}
			if (this.req >= this.numberRegisterSets - 1) {
				this.setStateAsync('info.status', { val: 'idle', ack: true });
			}
		});
	}

	/**
	 * start the timer for the next request
	 */
	async requestData() {
		try {
			this.updateInterval = setInterval(async () => {
				this.req = 0;
				this.counter++;
				this.sendRequest(this.req);
				await this.setStateAsync('info.lastUpdate', { val: Date.now(), ack: true });
				await this.setStateAsync('info.status', { val: 'automatic request', ack: true });
				// read to computed values and set subscriptions
				await this.readComputeAndWatch();
			}, this.sync_milliseconds);
		} catch (error) {
			this.log.debug(`[requestData] error: ${error} stack: ${error.stack}`);
		}
	}

	/**
	 * send request via idc-core
	 * @param {*} req
	 * @returns
	 */
	sendRequest(req) {
		if (!this.connectionActive) this.connect();
		if (req > this.numberRegisterSets - 1) return;
		const request = this.idc.requestFrame(req, this.idc.modbusFrame(req));
		//console.log(`Anfrage Registersatz: ${(req + 1)} > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);
	}

	/**
	 * set Power
	 * @param {*} id
	 * @param {*} state
	 */
	async setPower(id, state) {
		//console.log(`[setPower] <${id}> ${state.val}`);
		const req = 0;
		const powerControlRegister = 40;
		const data = [];
		if (state.val > 100) {
			data[0] = 100;
		} else {
			data[0] = state.val;
		}
		const request = this.idc.requestFrame(req, this.idc.modbusWriteFrame(powerControlRegister, data));
		//console.log(`Write Registersatz: ${(req)} > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);
	}

	/**
	 * Calculate data that cannot be read,
	 * the necessary values must be subscribed to in advance
	 * @param {*} id
	 * @param {*} state
	 * @returns
	 */
	async computeData(id, state) {
		const loggerSn = this.config.logger + '.';
		const pos = id.indexOf(loggerSn) + loggerSn.length;
		const basedir = id.substring(0, pos);
		const name = id.substring(pos);

		const jsonResult = [];
		const varCompute = [];

		if (state) {
			const changes = this.CalcValues.filter(calc => calc.values.includes(name));
			//
			for (let i = 0; i < changes.length; i++) {
				let computeResult = 0;
				for (let j = 0; j < changes[i].values.length; j++) {
					const state = await this.getStateAsync(basedir + changes[i].values[j]);

					if (typeof state?.val === 'number') {
						varCompute[j] = state?.val;
					} else {
						varCompute[j] = parseFloat(changes[i].values[j].replace(/[^0-9.]/g, ''));
					}
					//
					switch (changes[i].operation) {
						case '+':
							computeResult = varCompute[0] + varCompute[1];
							break;
						case '-':
							computeResult = varCompute[0] - varCompute[1];
							break;
						case '*':
							computeResult = varCompute[0] * varCompute[1];
							break;
						case '/':
							computeResult = varCompute[0] / varCompute[1];
							break;
					}
				}
				//console.log(`[computeResult #${i}#]  <${varCompute[0]}> ${changes[i].operation} <${varCompute[1]}> = ${computeResult}`);
				const product_hr = (computeResult * 10 ** -changes[i].factor).toFixed(2);
				const jsonObj = { key: changes[i].key, value: product_hr, unit: changes[i].unit, name: changes[i].name };
				jsonResult.push(jsonObj);
			}
		}
		return (jsonResult);
	}

	/**
	 * Preparing the compute formales and subscribing to the states
	 * @returns
	 */
	async readComputeAndWatch() {
		if (this.setWatchPoints) return;
		const basedir = this.namespace + '.' + this.config.logger + '.';
		const jsonResult = [];
		const varCompute = [];
		const watchStates = ['Power_Set'];
		const computeConfig = this.config.computes;
		if (computeConfig && Array.isArray(computeConfig)) {
			for (const obj of computeConfig) {
				const values = [];
				const response = mathOperation(obj.values);
				const operation = response?.operation;
				const position = response?.position;
				varCompute[0] = obj.values.slice(0, position).trim();
				varCompute[1] = obj.values.slice(position + 1).trim();
				values.push(varCompute[0]);
				values.push(varCompute[1]);
				//
				for (let i = 0; i < 2; i++) {
					const state = await this.getStateAsync(basedir + values[i]);
					if (state) { // != null
						if (!watchStates.includes(values[i])) {
							watchStates.push(values[i]);
						}
					}
				}
				const jsonString = { values: values, operation: operation, key: obj.key, name: obj.name, unit: obj.unit, factor: obj.factor };
				jsonResult.push(jsonString);
			}
			for (const watch of watchStates) {
				this.subscribeStates(this.config.logger + '.' + watch);
				this.log.debug(`[watchStates] set to ${watch}`);
			}
			this.setWatchPoints = true;
			//console.log(`[readCompute #3]  ${JSON.stringify(jsonResult)}`);
			this.CalcValues = jsonResult;
		}
		function mathOperation(computeString) {
			const defMathOperators = ['+', '-', '*', '/'];
			let position;
			for (let i = 0; i < defMathOperators.length; i++) {
				const zeichen = defMathOperators[i];
				position = computeString.indexOf(zeichen);
				if (position > 0) {
					const jsonString = { operation: computeString[position], position: position };
					return jsonString;
				}
			}
		}
	}

	/**
	 * PowerReset, if 'EHOSTUNREACH' arrived
	 * @param {*} err
	 */
	powerReset(err) {
		// Counter for PowerReset
		if (err.message.indexOf('EHOSTUNREACH') > 1) {
			this.resetCounter++;
			this.log.debug(`[powerReset] Counter ${this.resetCounter}`);
		}
		if (this.resetCounter == 29) {
			const jsonResult = [];
			const jsonString = { key: 'Apo_t1', value: 0, unit: 'x', name: 'y' };
			jsonResult.push(jsonString);
			this.updateData(jsonResult);
			this.log.debug(`[powerReset] Power resettet`);
		}
	}

	/**
	 * save data in ioBroker datapoints
	 * @param {*} key
	 * @param {*} name
	 * @param {*} value
	 * @param {*} role
	 * @param {*} unit
	 */
	async persistData(key, name, value, role, unit) {
		const dp_Device = String(this.config.logger) + '.' + key;
		// Type recognition
		let type = 'string';
		if (this.idc.isNumber(value)) {
			type = 'number';
			value = parseFloat(value);
		}
		if (typeof value === 'object') {
			type = 'string';
			value = JSON.stringify(value);
		}
		//this.log.debug(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}`);

		/*
		await this.setObjectNotExistsAsync(String(this.config.logger), {
			type: 'device',
			common: {
				name: String(this.config.logger)
			},
			native: {}
		});
*/

		await this.setObjectNotExistsAsync(dp_Device, {
			type: 'state',
			common: {
				name: name,
				role: role,
				// @ts-ignore
				type: type,
				// @ts-ignore
				unit: unit,
				read: true,
				write: false
			},
			native: {}
		});

		await this.setStateAsync(dp_Device, { val: value, ack: true });
	}

	/**
	 * prepare data vor ioBroker
	 * @param {*} data
	 */
	async updateData(data) {
		for (const obj of data) {
			if (obj.value != 'none') {
				await this.persistData(obj.key, obj.name, obj.value, 'value', obj.unit);
			}
		}
	}

	/**
	 * create object vor datavalues
	 */
	async createDPsForInstances() {
		const _loggerSn = String(this.config.logger);
		await this.setObjectNotExistsAsync(_loggerSn, {
			type: 'channel',
			common: { name: 'Values from Adapter and Instances' },
			native: {},
		});
	}

	/**
	 * check data from UI
	 * @returns
	 */
	async checkUserData() {
		// The adapters config (in the instance object everything under the attribute "native")
		// is accessible via this.config:
		// __________________
		// check if the IP-Address available
		if (!this.config.ipaddress) {
			this.log.error(`No inverter IP specified [${this.config.ipaddress}] .`);
			this.internDataReady = false;
			return;
		}
		// check if the IP-Address seems korrect
		if (validateIP(this.config.ipaddress)) {
			this.log.debug(`IP address [${this.config.ipaddress}] seems to be valid.`);
		} else {
			this.log.error(`IP address [${this.config.ipaddress}] is not valid !`);
			this.internDataReady = false;
			return;
		}
		// __________________
		// check if portnumber is setted
		if (this.config.port < 1024) {
			this.log.warn(`No port no specified [${this.config.port}] .`);
			this.config.port = 8899;
			this.log.info(`Standard port is used [${this.config.port}] .`);
		}
		// __________________
		// InverterNr is plausible
		if (!this.config.logger) {
			this.log.error(`No logger number specified [${this.config.logger}] .`);
			this.internDataReady = false;
			return;
		}
		if (this.config.logger < 2.1 * 10 ** 9) {
			this.log.error(`Logger number seems to be wrong [${this.config.logger}] .`);
			this.internDataReady = false;
			return;
		}
		this.idc.setLoggerSn(this.config.logger);
		// __________________
		// check if the sync time is a number, if not, the string is parsed to a number
		this.sync_milliseconds =
			typeof this.config.pollInterval === 'number'
				? this.config.pollInterval * 1000
				: parseInt(this.config.pollInterval, 10) * 1000;

		if (isNaN(this.sync_milliseconds) || this.sync_milliseconds < 0.5 * 1000) {
			this.sync_milliseconds = 300000; // is set as the minimum interval
			this.log.warn(`Sync time was too short (${this.config.pollInterval}). New sync time is 1 min`);
		}
		this.log.info(`Sync time set to ${this.sync_milliseconds} ms`);
		//
		this.log.debug(`checkUserData is ready`);
		return;
		//
		function validateIP(ip) {
			const pattern = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
			return pattern.test(ip);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug('[onUnload] cleaned everything up...');
			this.setState('info.connection', false, true);
			// Here you must clear all timeouts or intervals that may still be active
			//
			this.updateInterval && clearInterval(this.updateInterval);
			//
			this.client.destroy();
			this.setStateAsync(`info.status`, { val: 'offline', ack: true });
			callback();
		} catch (e) {
			callback();
		}
	}
}
// ##########  END  CLASS  ############

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Deyeidc(options);
} else {
	// otherwise start the instance directly
	new Deyeidc();
}
