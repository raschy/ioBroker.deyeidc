/* jshint -W097 */ // jshint strict:false
/*jslint node: true */

'use strict';
const fs = require('fs');
const path = require('path');

const fnCompute = './compute.json';

module.exports = class iobhandle {
	constructor() {
		console.log(`Class constructor`);
		//console.log(`dataDir: ${dataDir}`);
	}


	/**
		 * create needet Datapoints for Instances
		 */
	async createAdapterStates(adapter) {
		await adapter.setObjectNotExistsAsync('info.connection', {
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
		await adapter.setObjectNotExistsAsync('info.status', {
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
		await adapter.setObjectNotExistsAsync('info.lastUpdate', {
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
};