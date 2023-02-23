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

const netConnection = {
	serverConfigIp: '',
	serverConfigPort: 8899,
	inverterLoggerSn: 0,
	connectionActive: false,
	connectionNeeded: true,
	connectionPolling: 60,
};

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

		// -----------------  Timeout variables -----------------
		this.requestTimeout = null;
		this.sync_milliseconds = 60000; // 1min
		this.refreshStatus = false;
		// -----------------  Global variables -----------------
		this.idc = new idcCore();
		this.client = new net.Socket();
		this.client.setTimeout(20000);
		this.internDataReady = true;
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

		// Initialize your adapter Here
		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.idc.setLoggerSn(this.config.logger);
		this.log.debug(`config IP-Address: ${this.config.ipaddress}`);
		this.log.debug(`config Port: ${this.config.port}`);
		this.log.debug(`config Logger SN: ${this.config.logger}`);
		this.log.debug(`config Pollinterval: ${this.config.pollInterval}`);
		//
		//	About User changes
		await this.checkUserData();

		//	Laden der Register
		try {
			const registersConfig = this.config.registers;
			if (registersConfig && Array.isArray(registersConfig)) {
				//console.log(`[readRegisterset]  ${JSON.stringify(registersConfig)}`);
				this.idc.setRegisters(registersConfig);
			}
		} catch (e) {
			this.internDataReady = false;
			this.log.error(`[readRegisterset] ${e}`);
		}
		//
		//  Laden der Coils
		try {
			const coilConfig = this.config.coils;
			if (coilConfig && Array.isArray(coilConfig)) {
				//console.log(`[readCoilset]  ${JSON.stringify(coilConfig)}`);
				this.idc.setCoils(coilConfig);
			}
		} catch (err) {
			this.internDataReady = false;
			this.log.error(`[readCoilset] ${err}`);
		}

		//  Laden der Computes
		this.readComputeAndWatch();

		//
		if (this.internDataReady) {
			// Start connection handler to created & monitor websocket connection
			await this.connectionHandler();
			await this.requestData();
		}
		//
	}

	/*	*
		* Is called if a subscribed state changes
		* @param {string} id
		* @param {ioBroker.State | null | undefined} state
		*/
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			this.computeData(id, state);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	async computeData(id, state) {
		//console.log(`[onStateChange] ${id} <${JSON.stringify(state)}>`);
		const pos = id.lastIndexOf('.');
		const basedir = id.substring(0, pos);
		const name = id.substring(pos + 1);

		const jsonResult = []; // leeres Array
		if (state) {
			this.log.info(`state ${id} name: ${name}  changed: ${state.val} (ack = ${state.ack})`);

			const changes = this.CalcValues.filter(calc => calc.values.includes(name));
			//console.log(`[onStateChange] <${changes.length}> ${JSON.stringify(changes)}`);

			for (let i = 0; i < changes.length; i++) {
				let product = 1;
				for (let j = 0; j < changes[i].values.length; j++) {
					const state = await this.getStateAsync(basedir + '.' + changes[i].values[j]);
					//console.log(`[ #onStateChange# ##${i}#${j}## ] ${JSON.stringify(state)}`);

					if (typeof state?.val === 'number') {
						const value = state?.val;
						//console.log(`[ ##${i}#${j}## ] <${changes[i].values[j]}> ${JSON.stringify(state)}`);
						product *= value;
						if (j == changes[i].values.length - 1) {
							const product1 = (product * 10 ** changes[i].factor * 10 ** -changes[i].factor).toFixed(changes[i].factor);
							const jsonObj = { key: changes[i].key, value: product1, unit: changes[i].unit, name: changes[i].name };
							console.log(`Ergebnis = ${product1}  ${JSON.stringify(jsonObj)}`);
							jsonResult.push(jsonObj);
						}
					}

				}
			}
		}
		this.updateData(jsonResult);
	}


	connect() {
		console.log(`C O N N E C T`);
		this.client.connect({ host: '192.168.68.240', port: 8899 }); //, timeout: 50000 });
	}

	async connectionHandler() {
		this.client.on('connect', () => {
			netConnection.connectionActive = true;
			this.setState('info.connection', true, true);
		});

		this.client.on('timeout', () => {
			this.client.destroy();
			netConnection.connectionActive = false;
			this.setState('info.connection', false, true);
		});

		this.client.on('error', (err) => {
			this.client.destroy();
			netConnection.connectionActive = false;
			this.setState('info.connection', false, true);
			if (err) console.log(`Fehler bei Verbindung ${err.message}`);
		});

		this.client.on('end', () => {
			console.log('Verbindung mit Server beendet');
			netConnection.connectionActive = false;
			this.setState('info.connection', false, true);
		});

		this.client.on('data', (data) => {
			if (this.req < this.idc.Registers.length) {
				try {
					//console.log(`${this.idc.toHexString(data)}`);
					this.mb = this.idc.checkDataFrame(data);
					this.createDPsForInstances();
				} catch (err) {
					this.log.error(`${err}`);
				}

				// Analyse Data
				if (this.mb) {
					const output = this.idc.readCoils(this.idc.Registers, this.idc.Coils, this.mb);
					this.updateData(output);
				}


				// Nächste Anfrage senden
				if (data.length > 0) {
					this.req++;
					this.sendRequest(this.req);
				}
			}
		});
	}

	async requestData() {
		try {
			if (this.requestTimeout) clearTimeout(this.requestTimeout);
			// Abrufen der Daten
			this.req = 0;
			this.counter++;
			this.log.debug(`[requestData] Data request ${this.counter}`);
			this.sendRequest(this.req); // 1.Aufruf
			await this.setStateAsync(`info.lastUpdate`, { val: Date.now(), ack: true });
			// start the timer for the next request
			this.requestTimeout = setTimeout(async () => {
				await this.setStateAsync(`info.status`, { val: 'automatic request', ack: true });
				await this.requestData();
			}, this.sync_milliseconds);
		} catch (error) {
			this.log.debug(`[requestData] error: ${error} stack: ${error.stack}`);
		}
	}

	sendRequest(req) {
		if (!netConnection.connectionActive) this.connect();
		//
		if (req > this.idc.Registers.length - 1) return;
		const request = this.idc.request_frame(req);
		//console.log(`Anfrage Registersatz: ${(req + 1)} > ${this.idc.toHexString(request)}`); // human readable
		this.client.write(request);
	}

	readComputeAndWatch() {
		const jsonResult = [];
		const computeConfig = this.config.compute;
		if (computeConfig && Array.isArray(computeConfig)) {
			console.log(`[readCompute ##1]  ${JSON.stringify(computeConfig)}`);
			computeConfig.forEach(e => {
				console.log(`[readCompute ##2] ${e.value1} ${e.value2}`);
				this.log.debug(`[watchStates] set to ${e.value1} and ${e.value2}`);
				this.subscribeStates(this.config.logger + '.' + e.value1);
				this.subscribeStates(this.config.logger + '.' + e.value2);
				//
				const value = JSON.parse('["' + e.value1 + '","' + e.value2 + '"]');
				const jsonString = { values: value, key: e.key, name: e.name, unit: e.unit, factor: e.factor };
				jsonResult.push(jsonString);
			});
			console.log(`[readCompute ##3]  ${JSON.stringify(jsonResult)}`);
			this.CalcValues = jsonResult;
		}
	}

	async checkUserData() {
		// polling min 5min
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

		// check if the IP-Address seems korrect

		this.log.debug(`checkUserData is ready`);
		return;
	}

	/**
	 * create object für datavalues
	 */
	async createDPsForInstances() {
		const _loggerSn = String(this.config.logger);
		await this.setObjectNotExistsAsync(_loggerSn, {
			type: 'channel',
			common: {
				name: {
					en: 'Adapter and Instances',
					de: 'Adapter und Instanzen',
					ru: 'Адаптер и Instances',
					pt: 'Adaptador e instâncias',
					nl: 'Adapter en Instance',
					fr: 'Adaptateur et instances',
					it: 'Adattatore e istanze',
					es: 'Adaptador e instalaciones',
					pl: 'Adapter and Instances',
					uk: 'Адаптер та інстанції',
					'zh-cn': '道歉和案',
				},
			},
			native: {},
		});
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
			//clearInterval(this.intervalId);
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
