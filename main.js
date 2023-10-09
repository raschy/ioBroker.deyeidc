'use strict';

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const net = require('net');
const idcCore = require('./lib/idc-core.js');
let adapter;    // adapter instance - @type {ioBroker.Adapter}

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
		adapter = utils.adapter(Object.assign({}, options, {
			name: 'deyeidc',
		}));

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
		//
		this.idc = new idcCore();
		this.client = null;
		// -----------------  Timeout variables -----------------
		this.executionInterval = 60;
		// -----------------  Global variables -----------------
		this.connectionActive = false;
		this.internDataReady = true;
		this.numberRegisterSets = 0;
		this.numberCoils = 0;
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
		this.setState('info.connection', { val: false, ack: true });
		// The adapters config (in the instance object everything under the attribute "native")
		// is accessible via this.config:

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
		// already
		if (this.internDataReady) {
			// Start connection handler to created & monitor websocket connection
			//await this.checkOnlineDate();

			// First request
			this.req = 1;
			//console.log('Start >> Request: ', this.req);
			await this.requestData(this.req);
			// timed request
			this.updateInterval = setInterval(async () => {
				this.req = 1;
				console.log('Update >> Request: ', this.req);
				await this.requestData(this.req);
				//await this.checkOnlineDate(); // ######################
			}, this.executionInterval * 1000);
		} else {
			this.setState('info.connection', { val: false, ack: true });
			this.log.error('Adapter cannot be started without correct settings!');
		}
	}

	/**
	 * connection to inverter
	 */
	async connect() {
		this.log.debug(`try to connect . . .`);
		try {
			this.client = await this.connectToServer();
		} catch (error) {
			this.client = null;
			this.connectionActive = false;
		}
	}

	/**
	 * connectToServer
	 * @returns client
	 */
	connectToServer() {
		return new Promise((resolve, reject) => {
			const client = new net.Socket();

			client.connect({ host: this.config.ipaddress, port: this.config.port }, () => {
				this.log.debug('Connected to server');
				//client.setTimeout(15000);
				this.connectionActive = true;
				this.setState('info.connection', { val: this.connectionActive, ack: true });
				resolve(client); // Successful connection, return the socket
			});

			client.on('timeout', () => {
				this.log.debug('Connection timeout');
				client.destroy();
				if (client.destroyed) this.log.debug('Connection closed/destroyed');
				this.connectionActive = false;
				//this.setState('info.connection', { val: this.connectionActive, ack: true });
			});

			client.on('error', (error) => {
				this.log.debug('Connection error');
				this.connectionActive = false;
				this.setState('info.connection', { val: this.connectionActive, ack: true });
				if (error.message.indexOf('EHOSTUNREACH') > 1 || error.message.indexOf('ECONRESET')) {
					this.log.debug(`No connection to inverter: '${error.message}'`);
					this.offlineReset();
				} else {
					this.log.error(`Error during connection: ${error}`);
				}
				reject(error);
			});

			client.on('close', () => {
				this.log.debug('Connection closed');
				this.connectionActive = false;
				//this.setState('info.connection', { val: this.connectionActive, ack: true });
			});

			client.on('data', (data) => {
				this.onData(data);
			});
		});
	}

	/**
	 * onData
	 * @param {*} data
	 */
	async onData(data) {
		//console.log('Response by request [', this.req, '] >>', this.idc.toHexString(data)); // human readable
		try {
			this.mb = this.idc.checkDataFrame(data);
			// Preparation of the data
			if (this.mb) {
				this.log.debug(`Response: ${JSON.stringify(this.mb)}`); // human readable
				if (this.mb.register == 0) { // for request checkOnlineDate
					//console.log('Integration OfflineCheck');
					/*
					const dayHour = this.mb.modbus.subarray(3, this.mb.modbus.length - 1).readInt16LE(0);
					if (dayHour == 0) await this.setOfflineDate();
					// this.req = -1;	// continue with registerset 0, therefore set to -1!  // ##  ?? Integration OfflineCheck
					*/
				}
				if (this.mb.register > 0) {
					//console.log('   ### readCoils >> ', this.req, this.mb.register);
					await this.updateData(this.idc.readCoils(this.mb));
				}
			}
		} catch (err) {
			if (err.status == 'ECNTRLCODE') {
				this.log.warn(`${err.message}: Data may be corrupt, therefore discarded`);
			} else {
				this.log.error(`${err}`);
			}
		}

		// send next request
		if (data.length > 0) {
			if (this.req <= this.numberRegisterSets) {
				//console.log('Request    ####: ', this.req);
				this.requestData(this.req);
			}
			if (this.req == this.numberRegisterSets + 1) {
				//console.log('Request Else ##: ', this.req);
				//this.log.debug(`Data reception for ${this.req - 1} registersets completed`);
				this.req++;
				await this.readComputeAndWatch();
				await this.setStateAsync('info.lastUpdate', { val: Date.now(), ack: true });
				await this.setStateAsync('info.status', { val: 'idle', ack: true });
			}
		}
	}

	/**
	 * requestData (do the next request for registerset)
	 * @param {number} req
	 */
	async requestData(req) {
		if (!this.connectionActive) await this.connect();
		if (!this.connectionActive) return;
		try {
			if (!this.connectionActive) await this.connect();
			//console.log('requestData Try ', this.req);
			await this.setStateAsync('info.status', { val: 'automatic request', ack: true });
			const request = this.idc.requestFrame(req, this.idc.modbusFrame(req));
			//console.log(`Request to register set ${(req)} > ${this.idc.toHexString(request)}`); // human readable
			this.client.write(request);
			this.req++;	// next registerset
		} catch (error) {
			//console.log('requestData Catch');
			this.log.error(`[requestData] error: ${error} stack: ${error.stack}`);
		}
	}

	/**
	 * set Power
	 * @param {*} id
	 * @param {*} state
	 */
	async setPower(id, state) {
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
	 * checkOnlineDate
	 */
	async checkOnlineDate() {
		if (!this.connectionActive) this.connect();
		//console.log('##### checkOnlineDate ######');
		const dateControlRegister = 0x17; // Day&Hour
		const request = this.idc.requestFrame(0, this.idc.modbusReadFrame(dateControlRegister));
		//console.log(`Request to date  ( ddhh ) > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);
	}

	/**
	 * setOfflineDate
	 */
	async setOfflineDate() {
		const data = [];
		const req = 0;
		const dateControlRegister = 0x16;
		const d = new Date();
		data[0] = parseInt(decimalToHex(parseInt(d.getFullYear().toString().substring(2))) + decimalToHex(d.getMonth() + 1), 16);
		data[1] = parseInt(decimalToHex(d.getDate()) + decimalToHex(d.getHours()), 16);
		data[2] = parseInt(decimalToHex(d.getMinutes()) + decimalToHex(d.getSeconds()), 16);
		const request = this.idc.requestFrame(req, this.idc.modbusWriteFrame(dateControlRegister, data));
		this.log.debug(`[setOfflineDate] write: ${(req)} > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);

		function decimalToHex(dec) {
			let hex = Number(dec).toString(16);
			while (hex.length < 2) {
				hex = '0' + hex;
			}
			return hex;
		}
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
	 * it runs, if 'setWatchPoints' is false
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

	/**EHOSTUNREACH Connect_error:
	 * OfflineReset, if 'EHOSTUNREACH' arrived
	 */
	async offlineReset() {
		// Counter for OfflineReset
		//if (err.message.indexOf('EHOSTUNREACH') > 1) {
		this.resetCounter++;
		const startReset = Math.floor(540 / this.config.pollInterval);
		if (this.resetCounter == startReset) {
			this.log.debug(`[offlineReset] Values will be nullable.`);
			for (const obj of this.config.coils) {
				if (obj['nullable']) {
					this.log.debug(`offlineReset: ${obj.key}`);
					await this.persistData(obj.key, obj.name, 0, 'value', obj.unit, true);
				}
			}
		}
		//}
	}

	/**
	   * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		if (state) {
			// The state was changed
			if (id.indexOf('Power_Set') > 1) {
				await this.setPower(id, state);
			} else {
				await this.updateData(await this.computeData(id, state));
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
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
	async persistData(key, name, value, role, unit, nullable) {
		const dp_Device = name2id(String(this.config.logger));
		const dp_Value = dp_Device + '.' + name2id(key);
		//
		await this.setObjectNotExists(dp_Device, {
			type: 'channel',
			common: {
				name: 'Values from device',
				desc: 'generated by deyeidc',
				role: 'info'
			},
			native: {}
		});
		//
		// Type recognition <number>
		if (isNumber(value)) {
			value = parseFloat(value);
			//
			await this.setObjectNotExistsAsync(dp_Value, {
				type: 'state',
				common: {
					name: name,
					type: 'number',
					role: role,
					unit: unit,
					read: true,
					write: true,
				},
				native: {},
			});
			//console.log(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}" as type "number"`);
		} else { // or <string>
			await this.setObjectNotExistsAsync(dp_Value, {
				type: 'state',
				common: {
					name: name,
					type: 'string',
					role: role,
					unit: unit,
					read: true,
					write: true,
				},
				native: {},
			});
			//console.log(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}" as type "string"`);
		}
		// Differentiated writing of data
		if (nullable) {
			await this.setStateAsync(dp_Value, { val: 0, ack: true, q: 0x42 }); // Nullable values while device is not present
		} else {
			await this.setStateAsync(dp_Value, { val: value, ack: true, q: 0x00 });
		}
		//
		function isNumber(n) {
			return !isNaN(parseFloat(n)) && !isNaN(n - 0);
		}
		function name2id(pName) {
			return (pName || '').replace(adapter.FORBIDDEN_CHARS, '_').replace(/[-\s]/g, '_');
		}
	}

	/**
	 * prepare data vor ioBroker
	 * @param {*} data
	 */
	async updateData(data) {
		for (const obj of data) {
			if (obj.value != 'none') {
				await this.persistData(obj.key, obj.name, obj.value, 'value', obj.unit, false);

				//this.lastData[obj.key] = obj;
			}
		}
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
			this.log.warn(`No inverter IP specified [${this.config.ipaddress}] .`);
			this.internDataReady = false;
			return;
		}
		// check if the IP-Address seems korrect
		if (validateIP(this.config.ipaddress)) {
			this.log.debug(`IP address [${this.config.ipaddress}] seems to be valid.`);
		} else {
			this.log.warn(`IP address [${this.config.ipaddress}] is not valid !`);
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
			this.log.warn(`No logger number specified [${this.config.logger}] .`);
			this.internDataReady = false;
			return;
		}
		if (this.config.logger < 2.1 * 10 ** 9) {
			this.log.warn(`Logger number seems to be wrong [${this.config.logger}] .`);
			this.internDataReady = false;
			return;
		}
		this.idc.setLoggerSn(this.config.logger);
		// __________________
		// check if the sync time is a number, if not, the string is parsed to a number
		if (isNaN(this.config.pollInterval) || this.config.pollInterval < 30) {
			this.executionInterval = 60;
			this.log.warn(`Sync time was too short (${this.config.pollInterval} sec). New sync time is ${this.executionInterval} sec.`);
		} else {
			this.executionInterval = this.config.pollInterval;
		}
		this.log.info(`Retrieving data from the inverter will be done every ${this.executionInterval} seconds`);
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
	 * createObjectForDevices (loggerSN)
	 */
	async createObjectForDevices() {
		const loggerSn = String(this.config.logger);
		await this.setObjectNotExistsAsync(loggerSn, {
			type: 'channel',
			common: { name: 'Values from device', desc: 'generated by Deyeidc' },
			native: {},
		});
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug('[onUnload] cleaned everything up...');
			// Here you must clear all timeouts or intervals that may still be active
			//
			this.updateInterval && clearInterval(this.updateInterval);
			//
			this.client.destroy();
			this.setState('info.connection', { val: false, ack: true });
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
