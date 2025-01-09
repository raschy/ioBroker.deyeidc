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
	 * @param [options] {object} Some options
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
		this.idc = new idcCore(this.log);
		this.client = null;
		// -----------------  Timeout variables -----------------
		this.executionInterval = 60;
		// -----------------  Global variables -----------------
		this.connectionActive = false;
		this.internDataReady = true;
		this.numberRegisterSets = 0;
		this.numberCoils = 0;
		this.req = 0;
		this.memoryValues = [];
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
		this.idc = new idcCore(this.log);
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
			// first request
			this.req = 1;
			await this.requestData(this.req);
			// timed request
			this.updateInterval = this.setInterval(async () => {
				this.req = 1;
				await this.requestData(this.req);
			}, this.executionInterval * 1000);
		} else {
			this.setState('info.connection', { val: false, ack: true });
			this.log.error('Adapter cannot be started without correct settings!');
		}
	}

	/**
	 * connection to inverter
	 *
	 * @returns boolean
	 */
	async checkConnected() {
		if (this.connectionActive) {
			return true;
		}
		this.log.debug(`try to connect . . .`);
		try {
			this.client = await this.connectToServer();
			return true;
		} catch (error) {
			this.log.silly(`[checkConnected ] ${error}`);
			this.client = null;
			return false;
		}
	}

	/**
	 * connectToServer
	 *
	 * @returns client
	 */
	connectToServer() {
		return new Promise((resolve, reject) => {
			const client = new net.Socket();

			client.connect({ host: this.config.ipaddress, port: this.config.port }, () => {
				this.log.debug('Connected to server');
				this.connectionActive = true;
				this.setState('info.connection', {
					val: this.connectionActive,
					ack: true,
				});
				//client.set_Time_out(10000);
				resolve(client); // Successful connection, return the socket
			});
			/*
				  client.on('timeout', () => {
					  this.log.debug('Connection timeout');
					  client.destroy();
					  if (client.destroyed) this.log.debug('Connection closed/destroyed');
					  this.connectionActive = false;
					  this.setState('info.connection', { val: this.connectionActive, ack: true });
				  });
				  */
			client.on('error', error => {
				this.connectionActive = false;
				this.setState('info.connection', {
					val: this.connectionActive,
					ack: true,
				});
				if (error.message.indexOf('EHOSTUNREACH') > 1 || error.message.indexOf('ECONNRESET') > 1) {
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
				this.setState('info.connection', {
					val: this.connectionActive,
					ack: true,
				});
			});

			client.on('data', data => {
				this.onData(data);
			});
		});
	}

	/**
	 * onData
	 *
	 * @param data {Buffer}
	 */
	async onData(data) {
		try {
			const mb = this.idc.checkDataFrame(data);
			if (mb) {
				if (mb.register == 0) {
					//checkOnlineDate
					this.log.debug(`Response: (checkOnlineDate) ${JSON.stringify(mb)}`);
					if (mb.modbus[3] == 0) {
						await this.setOfflineDate();
					} //modbus[3] = Date/Day
				} else if (mb.register > 0) {
					//payload
					this.log.debug(`Response: (payload) ${JSON.stringify(mb)}`);
					await this.updateData(this.idc.readCoils(mb));
					this.req++;
					if (this.req <= this.numberRegisterSets) {
						this.requestData(this.req);
					} else if (this.req == this.numberRegisterSets + 1) {
						this.log.debug(`Data reception for ${this.req - 1} registersets completed`);
						await this.updateData(await this.computeData());
						if (this.config.onlinecheck) {
							await this.checkOnlineDate();
						}
						this.subscribeWatchpoint();
						this.setState('info.lastUpdate', { val: Date.now(), ack: true });
						this.setState('info.status', { val: 'idle', ack: true });
					}
				} else {
					//other messages
					this.log.silly(`RESPONSE ${JSON.stringify(mb)}`); // human readable ALL Responses
				}
			}
		} catch (err) {
			if (err.status == 'ECNTRLCODE') {
				this.log.silly(`${err.message}: Data may be corrupt, therefore discarded`);
			} else if (err.status == 'EFRAMECHK') {
				this.log.silly(`${err.message}: Frame CheckSum faulty!`);
			} else {
				this.log.error(`${err} | ${err.stack}`);
			}
		}
	}

	/**
	 * requestData (do the next request for registerset)
	 *
	 * @param req {number}
	 */
	async requestData(req) {
		if (await this.checkConnected()) {
			try {
				this.setState('info.status', { val: 'automatic request', ack: true });
				const request = this.idc.requestFrame(req, this.idc.modbusFrame(req));
				this.log.silly(`Request to register set ${req} > ${this.idc.toHexString(request)}`); // human readable
				this.client.write(request);
				this.resetCounter = 0;
			} catch (error) {
				this.log.error(`[requestData] error: ${error} stack: ${error.stack}`);
			}
		}
	}

	/**
	 * Calculate data that cannot be read,
	 * the necessary values must be calulated by formula
	 *
	 * @returns jsonResult
	 */
	async computeData() {
		const jsonResult = [];
		if (this.config.computes.length < 1 || this.memoryValues.length < 1) {
			return jsonResult;
		}
		let computeValue1 = 0;
		let computeValue2 = 0;
		let computeResult = 0;
		for (const obj of this.config.computes) {
			this.log.debug(`[computeData]  ${JSON.stringify(obj)}`);
			const response = mathOperation(obj.values);
			if (response) {
				const key1Index = this.memoryValues.findIndex(element => element.key == response.key1);
				if (key1Index == -1) {
					computeValue1 = parseFloat(response.key1);
					if (isNaN(computeValue1)) {
						this.log.warn(`Compute Key1 '${response.key1}' not found!`);
						continue;
					}
				} else {
					computeValue1 = parseFloat(this.memoryValues[key1Index].value);
				}
				//
				const key2Index = this.memoryValues.findIndex(element => element.key == response.key2);
				if (key2Index == -1) {
					computeValue2 = parseFloat(response.key2);
					if (isNaN(computeValue2)) {
						this.log.warn(`Compute Key2 '${response.key2}' not found!`);
						continue;
					}
				} else {
					computeValue2 = parseFloat(this.memoryValues[key2Index].value);
				}
				//
				const operation = response.operation;
				switch (operation) {
					case '+':
						computeResult = computeValue1 + computeValue2;
						break;
					case '-':
						computeResult = computeValue1 - computeValue2;
						break;
					case '*':
						computeResult = computeValue1 * computeValue2;
						break;
					case '/':
						if (computeValue2 == 0) {
							this.log.warn(`Compute Division '${response.key2}' by zero!`);
							continue;
						} else {
							computeResult = computeValue1 / computeValue2;
						}
						break;
					default:
						computeResult = -999;
				}
				//
				const key0 = this.removeInvalidCharacters(obj.key.trim());
				const result_hr = (computeResult * 10 ** -obj.factor).toFixed(2);
				const jsonObj = {
					key: key0,
					value: result_hr,
					unit: obj.unit,
					name: obj.name,
				};
				jsonResult.push(jsonObj);
			}
		}
		this.log.debug(`[computeData] ResultJson: ${JSON.stringify(jsonResult)}`);
		return jsonResult;

		// -- Helper --
		function mathOperation(computeString) {
			const defMathOperators = ['*', '/', '+', '-'];
			for (let i = 0; i < defMathOperators.length; i++) {
				const zeichen = defMathOperators[i];
				const position = computeString.indexOf(zeichen);
				if (position > 0) {
					i = defMathOperators.length;
					const key1 = computeString.slice(0, position).trim();
					const key2 = computeString.slice(position + 1).trim();
					const jsonString = {
						operation: computeString[position],
						key1: key1,
						key2: key2,
					};
					return jsonString;
				}
			}
		}
	}

	/**
	 * OfflineReset, if 'EHOSTUNREACH' arrived
	 */
	async offlineReset() {
		// Counter for OfflineReset
		this.resetCounter++;
		const startReset = Math.floor(540 / this.config.pollInterval);
		this.log.debug(`[offlineReset] ${this.resetCounter} / ${startReset}`);
		if (this.resetCounter == startReset) {
			this.log.debug(`[offlineReset] Values will be nullable.`);
			for (const obj of this.config.coils) {
				if (obj['nullable']) {
					this.log.debug(`[offlineReset] ${obj.key}`);
					await this.persistData(obj.key, obj.name, 0, 'value', obj.unit, true);
				}
			}
		}
	}

	/**
	 * set actual date to inverter (for daily data-reset)
	 */
	async setOfflineDate() {
		if (await this.checkConnected()) {
			const data = [];
			const req = 0;
			const dateControlRegister = 0x16;
			const d = new Date();
			data[0] = parseInt(
				decimalToHex(parseInt(d.getFullYear().toString().substring(2))) + decimalToHex(d.getMonth() + 1),
				16,
			);
			data[1] = parseInt(decimalToHex(d.getDate()) + decimalToHex(d.getHours()), 16);
			data[2] = parseInt(decimalToHex(d.getMinutes()) + decimalToHex(d.getSeconds()), 16);
			const request = this.idc.requestFrame(req, this.idc.modbusWriteFrame(dateControlRegister, data));
			this.log.debug(`[setOfflineDate] write: ${req} > ${this.idc.toHexString(request)}`); // human readable
			this.client.write(request);
		}

		function decimalToHex(dec) {
			let hex = Number(dec).toString(16);
			while (hex.length < 2) {
				hex = `0${hex}`;
			}
			return hex;
		}
	}

	/**
	 * checkOnlineDate
	 */
	async checkOnlineDate() {
		if (await this.checkConnected()) {
			const dateControlRegister = 0x17; // Day&Hour
			const request = this.idc.requestFrame(0, this.idc.modbusReadFrame(dateControlRegister));
			this.log.silly(`Request to date  ( ddhh ) > ${this.idc.toHexString(request)}`); // human readable
			this.client.write(request);
		}
	}

	/**
	 * Set a subscriber to watchState 'Power_Set'
	 * Subscribe first when object has been created
	 */
	async subscribeWatchpoint() {
		if (this.setWatchPoints) {
			return;
		}
		const watch = `${this.config.logger}.Power_Set`;
		this.subscribeStates(watch);
		this.log.debug(`[subscribeWatchpoint] set to ${watch}`);
		this.setWatchPoints = true;
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param id {string} state id that changed
	 * @param state {any} the state it changed to
	 */
	async onStateChange(id, state) {
		if (state) {
			// The state was changed
			if (id.indexOf('Power_Set') > 1 && !state.ack) {
				await this.setPower(id, state);
			}
		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	/**
	 * set Power
	 *
	 * @param id {string}
	 * @param state {any}
	 */
	async setPower(id, state) {
		if (await this.checkConnected()) {
			const req = 0;
			const powerControlRegister = 40;
			const data = [];
			if (state.val < 1 || state.val > 100) {
				data[0] = 100;
			} else {
				data[0] = state.val;
			}
			this.log.debug(`[setPower] Power set to ${data[0]}%`);
			const request = this.idc.requestFrame(req, this.idc.modbusWriteFrame(powerControlRegister, data));
			this.client.write(request);
			this.setState(id, { val: data[0], ack: true });
		}
	}

	/**
	 * save data in ioBroker datapoints
	 *
	 * @param key (key from inverter)
	 * @param name (name for ioBroker)
	 * @param value (value from inverter)
	 * @param role (role for ioBroker)
	 * @param unit (unit for ioBroker)
	 * @param nullable (nullable for ioBroker)
	 */
	async persistData(key, name, value, role, unit, nullable) {
		const dp_Device = this.removeInvalidCharacters(String(this.config.logger));
		const dp_Value = `${dp_Device}.${this.removeInvalidCharacters(key)}`;
		//
		await this.setObjectNotExists(dp_Device, {
			type: 'channel',
			common: {
				name: 'Values from device',
				desc: 'generated by deyeidc',
				role: 'info',
			},
			native: {},
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
			//this.log.debug(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}" as type "number"`);
		} else {
			// or <string>
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
			//this.log.debug(`[persistData] Device "${dp_Device}"  Key "${key}" with value: "${value}" and unit "${unit}" with role "${role}" as type "string"`);
		}
		// Differentiated writing of data
		if (nullable) {
			await this.setState(dp_Value, { val: 0, ack: true, q: 0x42 }); // Nullable values while device is not present
		} else {
			await this.setState(dp_Value, { val: value, ack: true, q: 0x00 });
		}
		//
		function isNumber(n) {
			return !isNaN(parseFloat(n)) && !isNaN(n - 0);
		}
	}

	/**
	 * prepare data vor ioBroker
	 *
	 * @param data {array}
	 */
	async updateData(data) {
		if (data) {
			for (const obj of data) {
				if (obj.value != 'none') {
					const elementIndex = this.memoryValues.findIndex(element => element.key == obj.key);
					if (elementIndex == -1) {
						// new memory object
						const jsonString = { key: obj.key, value: obj.value };
						this.memoryValues.push(jsonString);
					} else {
						// update memory object
						this.memoryValues[elementIndex].value = obj.value;
					}
					await this.persistData(obj.key, obj.name, obj.value, 'value', obj.unit, false);
				}
			}
		}
	}

	/**
	 * check data from UI
	 *
	 * @returns boolean
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
			this.log.warn(`No port no specified [${this.config.port}].`);
			this.config.port = 8899;
			this.log.info(`Standard port is used [${this.config.port}].`);
		}
		// __________________
		// InverterNr is plausible
		if (!this.config.logger) {
			this.log.warn(`No logger number specified [${this.config.logger}].`);
			this.internDataReady = false;
			return;
		}
		if (this.config.logger < 2 * 10 ** 9) {
			this.log.warn(`Logger number seems to be wrong [${this.config.logger}].`);
			this.internDataReady = false;
			return;
		}
		this.idc.setLoggerSn(this.config.logger);
		// __________________
		// check if the sync time is a number, if not, the string is parsed to a number
		if (isNaN(this.config.pollInterval) || this.config.pollInterval < 1) {
			this.executionInterval = 60;
			this.log.warn(
				`Sync time was too short (${this.config.pollInterval} sec). New sync time is ${this.executionInterval} sec.`,
			);
		} else {
			this.executionInterval = this.config.pollInterval;
		}
		this.log.info(`Retrieving data from the inverter will be done every ${this.executionInterval} seconds`);
		//
		this.log.debug(`checkUserData is ready`);
		return;
		//
		function validateIP(ip) {
			const ipPattern = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
			const domainPattern = /^(?!:\/\/)([a-zA-Z0-9-_]+\.)+[a-zA-Z]{2,}$/;
			return ipPattern.test(ip) || domainPattern.test(ip);
		}
	}

	/**
	 * createObjectForDevices (loggerSN)
	 */
	async createObjectForDevices() {
		const loggerSn = String(this.config.logger);
		await this.setObjectNotExistsAsync(loggerSn, {
			type: 'channel',
			common: {
				name: {
					en: 'Values from device',
					de: 'Werte vom Gerät',
					ru: 'Значения от устройства',
					pt: 'Valores do dispositivo',
					nl: 'aarden van het apparaat',
					fr: "Valeurs de l'appareil",
					it: 'Valori dal dispositivo',
					es: 'Valores desde el dispositivo',
					pl: 'Wartości z urządzenia',
					uk: 'Ціни від пристрою',
					'zh-cn': '来自设备的值',
				},
				desc: 'generated by Deyeidc',
			},
			native: {},
		});
	}

	/**
	 *
	 * @param inputString {string}
	 * @returns cleaned string
	 */
	removeInvalidCharacters(inputString) {
		//return inputString;
		const regexPattern = '[^a-zA-Z0-9]+';
		const regex = new RegExp(regexPattern, 'gu');
		return inputString.replace(regex, '_');
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback {() => void}
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
			this.setState(`info.status`, { val: 'offline', ack: true });
			callback();
		} catch (e) {
			callback();
			this.log.debug(`[onUnload] ${JSON.stringify(e)}`); //eslint no-unused-vars
		}
	}
}
// ##########  END  CLASS  ############

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param [options] {object} Some options
	 */
	module.exports = options => new Deyeidc(options);
} else {
	// otherwise start the instance directly
	new Deyeidc();
}
