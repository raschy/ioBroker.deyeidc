'use strict';
/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const fs = require('fs');
const net = require('net');
const idcCore = require('./lib/idc-core.js');
//
const fnCompute = './compute.json';

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
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Reset the connection indicator during startup
		this.createAdapterObjects();
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
			this.idc.readRegisterset();
		} catch (e) {
			this.internDataReady = false;
			this.log.error(`}readRegisterset: ${e}`);
		}
		//
		//  Laden der Coils
		try {
			this.idc.readCoilset();
		} catch (err) {
			this.internDataReady = false;
			this.log.error(`[readCoilset] ${err}`);
		}

		//
		if (this.internDataReady) {
			// Start connection handler to created & monitor websocket connection
			await this.connectionHandler();
			await this.requestData();
			// Beobachten der zu berechnenden Daten
			this.watchStates();
		}
		//
	}

	/**
		 * Is called if a subscribed state changes
		 * @param {string} id
		 * @param {ioBroker.State | null | undefined} state
		 */
	async onStateChange(id, state) {
		//console.log(id, state);
		const pos = id.lastIndexOf('.');
		const basedir = id.substring(0, pos);
		const name = id.substring(pos + 1);

		const jsonResult = []; // leeres Array
		if (state) {
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
			const changes = this.CalcValues.filter(calc => calc.values.includes(name));

			for (let i = 0; i < changes.length; i++) {
				let product = 1;
				for (let j = 0; j < changes[i].values.length; j++) {
					const state = await this.getStateAsync(basedir + '.' + changes[i].values[j]);

					if (typeof state?.val === 'number') {
						const value = state?.val;
						product *= value;
						if (j == changes[i].values.length - 1) {
							const product1 = (product * 10 ** changes[i].factor * 10 ** -changes[i].factor).toFixed(changes[i].factor);
							const jsonObj = { key: changes[i].key, value: product1, unit: changes[i].unit, name: changes[i].name };
							jsonResult.push(jsonObj);
							this.updateData(jsonObj);
						}
					}
				}
			}
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
		this.updateData(jsonResult);
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
				await this.setStateAsync(`info.status`, {
					val: 'automatic request',
					ack: true,
				});
				await this.requestData();
			}, this.sync_milliseconds);
		} catch (error) {
			this.log.debug(`[ requestData ] error: ${error} stack: ${error.stack}`);
		}
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

	sendRequest(req) {
		if (!netConnection.connectionActive) this.connect();
		//
		if (req > this.idc.Registers.length - 1) return;

		console.log('Anfrage Registersatz: ' + (req + 1)); // human readable
		const request = this.idc.request_frame(req);
		this.client.write(request);
	}

	watchStates() {
		try {
			const jsonData = fs.readFileSync(fnCompute, { encoding: 'utf8', flag: 'r' });
			this.CalcValues = JSON.parse(jsonData); //now it is an object
			this.CalcValues.forEach(e => {
				e.values.forEach(value => this.subscribeStates(this.config.logger + '.' + value));
			});
		} catch (err) {
			console.warn(err);
			this.log.warn(`[watchStates] Cannot read JSON file: ${fnCompute}`);
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

		console.log(`checkUserData is ready`);
		return;
	}

	/**
	 * create needet Datapoints for Instances
	 */
	async createAdapterObjects() {
		await this.setObjectNotExistsAsync('info.connection', {
			type: 'state',
			common: {
				name: 'Connection to Device##',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('info.status', {
			type: 'state',
			common: {
				name: 'Status',
				type: 'string',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
		await this.setObjectNotExistsAsync('info.lastUpdate', {
			type: 'state',
			common: {
				name: 'Last Update',
				type: 'number',
				role: 'state',
				read: true,
				write: false,
			},
			native: {},
		});
	}

	/**
	 * create Object für datavalues
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
		//console.log(`[updateData] JSON: ${JSON.stringify(data)}`);

		// define keys that shall not be updated (works in dataList only)
		const noUpdateKeys = JSON.parse(JSON.stringify(this.config.deviceBlacklist.split(',')));

		Object.keys(data).forEach(pos => {
			const result = noUpdateKeys.includes(data[pos].key);
			//console.log(`updateData ${data[pos].key} ${result}`);
			if (!result) { // || data[pos].value == 'none'
				this.persistData(data[pos].key, data[pos].name, data[pos].value, 'state', data[pos].unit);
			}
		});
	}

	async persistData(key, name, value, role, unit) {
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
			this.setStateAsync(`info.status`, {
				val: 'offline',
				ack: true,
			});
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
