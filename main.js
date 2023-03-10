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
		this.client.setTimeout(10000);
		// -----------------  Timeout variables -----------------
		this.requestTimeout = null;
		this.sync_milliseconds = 60000; // 1min
		// -----------------  Global variables -----------------
		this.connectionActive = false;
		this.internDataReady = true;
		this.numberRegisterSets = 0;
		this.numberCoils = 0;
		this.counter = 0;
		this.req = 0;
		this.CalcValues = [];
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

		//	Laden der Register
		try {
			const RegisterSets = this.config.registers;
			if (RegisterSets && Array.isArray(RegisterSets)) {
				//console.log(`[readRegisterset]  ${JSON.stringify(RegisterSets)}`);
				this.numberRegisterSets = RegisterSets.length;
				this.idc.setRegisters(RegisterSets);
			}
		} catch (e) {
			this.internDataReady = false;
			this.log.error(`[readRegisterset] ${e}`);
		}
		//
		//  Laden der Coils
		try {
			const Coils = this.config.coils;
			if (Coils && Array.isArray(Coils)) {
				//console.log(`[readCoilset]  ${JSON.stringify(Coils)}`);
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
			// read to computed values and set subscriptions
			await this.readComputeAndWatch();
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
			//this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			this.updateData(await this.computeData(id, state));

		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	connect() {
		console.log(`C O N N E C T`);
		this.client.connect({ host: this.config.ipaddress, port: this.config.port });
	}

	async connectionHandler() {
		this.client.on('connect', () => {
			this.connectionActive = true;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('timeout', () => {
			this.client.destroy();
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('error', (err) => {
			this.client.destroy();
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
			if (err) console.log(`Fehler bei Verbindung ${err.message}`);
		});

		this.client.on('end', () => {
			console.log('Verbindung mit Server beendet');
			this.connectionActive = false;
			this.setState('info.connection', this.connectionActive, true);
		});

		this.client.on('data', (data) => {
			console.log(`Request ${this.req}`);
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

				// N??chste Anfrage senden
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
			if (this.requestTimeout) clearTimeout(this.requestTimeout);
			// Abrufen der Daten
			this.req = 0;
			this.counter++;
			this.sendRequest(this.req); // 1.Aufruf
			await this.setStateAsync('info.lastUpdate', { val: Date.now(), ack: true });
			// start the timer for the next request
			this.requestTimeout = setTimeout(async () => {
				await this.setStateAsync('info.status', { val: 'automatic request', ack: true });
				await this.requestData();
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
		const pos = id.lastIndexOf('.');
		const basedir = id.substring(0, pos);
		const name = id.substring(pos + 1);

		const jsonResult = []; // leeres Array
		if (state) {

			const changes = this.CalcValues.filter(calc => calc.values.includes(name));
			//console.log(`[onStateChange] <${changes.length}> ${JSON.stringify(changes)}`);

			for (let i = 0; i < changes.length; i++) {
				let product = 1;
				for (let j = 0; j < changes[i].values.length; j++) {
					const state = await this.getStateAsync(basedir + '.' + changes[i].values[j]);

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
			console.log(`[readCompute ##3]  ${JSON.stringify(jsonResult)}`);
			this.CalcValues = jsonResult;
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
		data.forEach(async (obj) => {
			if (obj.value != 'none') {
				await this.persistData(obj.key, obj.name, obj.value, 'value', obj.unit);	//'state'
			}
		});
	}

	// create object f??r datavalues
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
			this.log.error(`keine Inverter Ip angegeben [${this.config.ipaddress}] .`);
			this.internDataReady = false;
			return;
		}
		// check if the IP-Address seems korrect
		if (validateIP(this.config.ipaddress)) {
			this.log.debug(`Die IP-Adresse scheint g??ltig [${this.config.ipaddress}] .`);
		} else {
			this.log.error(`Die IP-Adresse ist ung??ltig [${this.config.ipaddress}] !`);
			this.internDataReady = false;
			return;
		}
		// __________________
		// check if portnumber is setted
		if (this.config.port < 1024) {
			this.log.warn(`keine Port Nr angegeben [${this.config.port}] .`);
			this.config.port = 8899;
			this.log.info(`Standard-Port wird verwendet [${this.config.port}] .`);
		}
		// __________________
		// InverterNr is plausible
		if (!this.config.logger) {
			this.log.error(`keine Logger Nummer angegeben [${this.config.logger}] .`);
			this.internDataReady = false;
			return;
		}
		if (this.config.logger < 4000000000) {
			this.log.error(`Logger Nummer scheint falsch zu sein [${this.config.logger}] .`);
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
			// ...
			if (this.requestTimeout) clearInterval(this.requestTimeout);
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
