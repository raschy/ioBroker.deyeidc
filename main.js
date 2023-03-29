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
			name: 'deyeidc', //adapterName
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
		//
		this.idc = new idcCore();
		this.client = new net.Socket();
		//this.client.setTimeout(30000);	//deactiviert
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
		}
	}

	/*	*
		* Is called if a subscribed state changes
		* @param {string} id
		* @param {ioBroker.State | null | undefined} state
		*/
	async onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.debug(`state ${id} has changed`);
			this.updateData(await this.computeData(id, state));

		} else {
			// The state was deleted
			this.log.debug(`state ${id} deleted`);
		}
	}

	connect() {
		this.log.debug(`try to connect . . .`);
		this.client.connect({ host: this.config.ipaddress, port: this.config.port });
	}

	async connectionHandler() {
		this.client.on('connect', () => {
			this.log.debug(`connected`);
			this.connectionActive = true;
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
		});

		this.client.on('end', () => {
			this.log.debug(`Connection to server terminated`);
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('data', (data) => {
			//console.log(`Request ${this.req}`);
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

				// Nächste Anfrage senden
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

	async requestData() {
		try {
			// start the timer for the next request
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

	sendRequest(req) {
		if (!this.connectionActive) this.connect();
		//
		if (req > this.numberRegisterSets - 1) return;
		const request = this.idc.request_frame(req);
		//console.log(`Anfrage Registersatz: ${(req + 1)} > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);

	}

	async computeData(id, state) {
		const loggerSn = this.config.logger + '.';
		const pos = id.indexOf(loggerSn) + loggerSn.length;
		const basedir = id.substring(0, pos);
		const name = id.substring(pos);

		const jsonResult = []; // leeres Array
		if (state) {

			const changes = this.CalcValues.filter(calc => calc.values.includes(name));
			//console.log(`[computeData] <${changes.length}> ${JSON.stringify(changes)}`);

			for (let i = 0; i < changes.length; i++) {
				let product = 1;
				for (let j = 0; j < changes[i].values.length; j++) {
					const state = await this.getStateAsync(basedir + changes[i].values[j]);
					//console.log(`[computeData ##] ${i} ${j} ## ${basedir} <${changes[i].values[j]}> ${JSON.stringify(state)} `);

					if (typeof state?.val === 'number') {
						const value = state?.val;
						product *= value;
						if (j == changes[i].values.length - 1) {
							const product_hr = product.toFixed(changes[i].factor);
							const jsonObj = { key: changes[i].key, value: product_hr, unit: changes[i].unit, name: changes[i].name };
							//console.log(`Ergebnis = ${product_hr}  ${JSON.stringify(jsonObj)}`);
							jsonResult.push(jsonObj);
						}
					}
				}
			}
		}
		return (jsonResult);
	}

	async readComputeAndWatch() {
		if (this.setWatchPoints) return;
		const jsonResult = [];
		const computeConfig = this.config.computes;
		if (computeConfig && Array.isArray(computeConfig)) {
			console.log(`[readCompute ##1] ${JSON.stringify(computeConfig)}`);
			computeConfig.forEach(e => {
				console.log(`[readCompute ##2] ${e.value1} ${e.value2}`);
				if (e.value1 != 'none' && e.value1.length < 2) {
					this.log.warn(`[watchStates] Value1 "${e.value1}" is not valid!`);
					return;
				}
				if (e.value2 != 'none' && e.value2.length < 2) {
					this.log.warn(`[watchStates] Value2 "${e.value2}" is not valid!`);
					return;
				}
				this.log.debug(`[watchStates] set to ${e.value1} and ${e.value2}`);
				this.subscribeStates(this.config.logger + '.' + e.value1);
				this.subscribeStates(this.config.logger + '.' + e.value2);
				//
				const values = JSON.parse('["' + e.value1 + '","' + e.value2 + '"]');
				console.log(`[readCompute Values]  ${JSON.stringify(values)}`);
				const jsonString = { values: values, key: e.key, name: e.name, unit: e.unit, factor: e.factor };
				jsonResult.push(jsonString);
			});
			//console.log(`[readCompute ##3]  ${JSON.stringify(jsonResult)}`);
			this.CalcValues = jsonResult;
			this.setWatchPoints = true;
		}
	}

	// save data in ioBroker datapoints
	async persistData(key, name, value, role, unit) {
		//console.log(`[persistData] ${key}`);
		const dp_Device = String(this.config.logger) + '.' + key;
		// Type-Erkennung
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

	// prepare data vor ioBroker
	async updateData(data) {
		//console.log(`[updataData] ${JSON.stringify(data)}`);
		//data.forEach(async (obj) => {
		for (const obj of data) {
			if (obj.value != 'none') {
				await this.persistData(obj.key, obj.name, obj.value, 'value', obj.unit);	//'state'
			}
		}
	}

	// create object für datavalues
	async createDPsForInstances() {
		const _loggerSn = String(this.config.logger);
		await this.setObjectNotExistsAsync(_loggerSn, {
			type: 'channel',
			common: { name: 'Values from Adapter and Instances' },
			native: {},
		});
	}

	// check data from UI
	async checkUserData() {
		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
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
		if (this.config.logger < 3900000000) {
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
