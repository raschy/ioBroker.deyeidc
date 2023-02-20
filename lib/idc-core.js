/* jshint -W097 */ // jshint strict:false
/*jslint node: true */

'use strict';
const fs = require('fs');
const path = require('path');
const dataDir = '/home/raschy/ioBroker.deyeidc';

const fnRegister = 'register.json';
const fnCoils = './coils.json';
const fileRegister = path.join(dataDir, fnRegister);
const fileCoils = path.join(dataDir, fnCoils);

class MyError extends Error {
	constructor(err) {
		super(err.message);
		this.err = err.status;
	}
}

module.exports = class idcCore {
	constructor() {
		console.log(`Class constructor`);
		console.log(`dataDir: ${dataDir}`);
		console.log(`fileRegister: ${fileRegister}`);
		console.log(`fileCoils: ${fileCoils}`);
	}

	setLoggerSn(loggerSn) {
		this.loggerSn = loggerSn;
	}

	checkDataFrame(data) {
		const debugging = false;
		//
		const bufferInHex = Buffer.from(data); // init a buffer
		if (debugging) console.log(`(f)checkDataFrame Data: ${data}`);
		//
		const dataLen = data.length;
		if (debugging) console.log(`(f) checkDataFrame Länge des Datensatz: ${dataLen}`);
		const checkSumFrame_received = bufferInHex.readUInt8(dataLen - 2).toString(16);
		const checkSumFrame_calculated = this.request_checksum(data).toString(16);
		if (debugging) console.log(`(f) checkDataFrame CheckSumme_Frame: ${checkSumFrame_received}|${checkSumFrame_calculated}`);
		if (checkSumFrame_received != checkSumFrame_calculated) {
			console.error('(f) checkDataFrame Frame CheckSum faulty!');
			throw new MyError({ status: 400, message: `Frame CheckSum faulty! ${checkSumFrame_received}` });
		}
		//
		const start = bufferInHex.readUInt8(0).toString(10); // expected: 165
		if (debugging) console.log(`(f) checkDataFrame StartByte: ${start}`);
		const msgLen = parseInt(bufferInHex.readUInt16LE(1).toString(10)); // expected: 59,51,35
		const modbusLen = msgLen - 14;
		if (debugging) console.log(`(f) checkDataFrame Messagelength: ${msgLen}|${modbusLen}`);
		const cntrlCode = bufferInHex.readUInt16BE(3); //.toString(10);	// expected: 4117 (0x1015)
		if (debugging) console.log(`(f) checkDataFrame ControlCode: ${cntrlCode}`);
		if (cntrlCode != 4117) {
			console.error(`(f) checkDataFrame ControlCode faulty!`);
			throw new MyError({ status: 400, message: `ControlCode faulty!` });
		}
		const reqNr = parseInt(bufferInHex.readUInt8(5).toString(10));
		if (debugging) console.log(`(f) checkDataFrame Requestnummer: ${reqNr}`);
		const seqNrB = bufferInHex.readUInt8(6).toString(10);
		if (debugging) console.log(`(f) checkDataFrame SequenzNummer: ${seqNrB}`);

		/*
		Response Payload
		A response payload is 14 bytes + the length of the Modbus RTU response frame, and is composed of:
		Frame Type (one byte) – Denotes the frame type, where:
		0x02: Solar Inverter
		0x01: Data Logging Stick
		0x00: Solarman Cloud (or keep alive?)
		Status (one byte) – Denotes the request status. 0x01 appears to denote success.
		Delivery Time (four bytes) – Denotes the time since data logging stick was booted for the very first time,
		in seconds. Other implementations have this field named TimeOutOfFactory.
		Power On Time (four bytes) – Denotes the current uptime of the data logging stick in seconds.
		Offset Time (four bytes) – Denotes the current boot time of the data logging stick in seconds since the Unix epoch.
		Modbus RTU Frame (variable length) – Modbus RTU response frame.
	*/
		if (msgLen > 1) {
			const frameType = bufferInHex.readUInt8(11).toString(10); // expected: 2
			if (debugging) console.log(`(f) checkDataFrame FrameType: ${frameType}`);
			const status = bufferInHex.readUInt8(12).toString(10); // expected: 1
			if (debugging) console.log(`(f) checkDataFrame Status: ${status}`);
			const totalWorkingTime = bufferInHex.readUInt32LE(13).toString(10); // expected: 5133430 > 59d 09:57:10
			if (debugging) console.log(`(f) checkDataFrame totalWorkingTime: '${totalWorkingTime} > ${this.sec2DayTime(totalWorkingTime)}`);
			const powerOnTime = bufferInHex.readUInt32LE(17).toString(10); // expected: 2373 > 00:39:33
			if (debugging)
				console.log(`(f) checkDataFrame powerOnTime: ${powerOnTime} > ${this.sec2Time(powerOnTime)}`);
			const offsetTime = bufferInHex.readUInt32LE(21).toString(10); // expected: 1667756763 > Sun Nov 06 2022 18:46:03
			//const offsetTime = 1667756763;	//####  !!!
			if (debugging) console.log(`(f) checkDataFrame offsetTime: ${offsetTime} > ${this.toDate(offsetTime)}`);
			const captureData = parseInt(totalWorkingTime) + parseInt(offsetTime);
			if (debugging)
				console.log(`'(f) checkDataFrame Capture data: ${captureData} > ${this.toDate(captureData)}`);
			// Modbus
			const checkSumModbus_received = bufferInHex.readUInt8(dataLen - 3).toString(16);
			const checkSumModbus_calculated = this.modbus_checksum(bufferInHex.subarray(25, bufferInHex.length - 3)).toString(16);
			if (debugging) console.log(`(f) checkDataFrame CheckSum_Modbus: ${checkSumModbus_received}|${checkSumModbus_calculated}`);
			// Plausi
			if (checkSumModbus_received != checkSumModbus_calculated) {
				console.log('(f) checkDataFrame CheckSumme Modbus faulty!');
			}
			if (parseInt(offsetTime) < 1) {
				console.log('(f) checkDataFrame Offset Time is invalid!');
				throw new MyError({ status: 400, message: `Offset Time is invalid` });
			}
			return {
				register: reqNr,
				modbus: bufferInHex.subarray(25, bufferInHex.length - 3),
			};
		}
	}

	readCoils(Registers, Coils, data) {
		const debugging = false;
		//
		if (debugging) console.log(`Registersatz ##: ${data.register}`);
		const jsonResult = []; // leeres Array

		if (data.register > 0) {
			if (debugging) console.log(`Startcoil: ${Registers[data.register - 1].registerStart}`);

			const modbus_data = data.modbus.subarray(3, data.modbus.length - 1);
			if (debugging) console.log(`ModbusData: ${modbus_data}`);

			for (let i = 0; i < modbus_data.length / 2; i++) {
				// var result = Coils.find(obj => {
				const resultFilter = Coils.filter((obj) => {
					return obj.register === Registers[data.register - 1].registerStart + i;
				});

				if (resultFilter.length > 0) {
					for (let j = 0; j < resultFilter.length; j++) {
						const result = resultFilter[j];

						switch (result.rules) {
							case 1: {
								const value = (modbus_data.readUInt16BE(i * 2) * 10 ** -result.factor).toFixed(result.factor);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: value, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 2: {
								const low_word = modbus_data.readUInt16BE(i * 2);
								const high_word = modbus_data.readUInt16BE((i + 1) * 2);
								const value = ((low_word + high_word * 65536) / 10 ** result.factor).toFixed(result.factor);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: value, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 3: {
								// für Seriennummer
								let serialnr = 0;
								for (j = 0; j < 10; j++) {
									serialnr += (modbus_data.readUInt8(i * 2 + j) - 48) * 10 ** (9 - j);
								}
								if (debugging) console.log('(f) readCoils SerialNumber: ', serialnr);
								const jsonObj = { key: result.key, value: serialnr, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 4: {
								// für Temperatur
								const rawValue = modbus_data.readUInt16BE(i * 2);
								const value = ((modbus_data.readUInt16BE(i * 2) - 1000) / 10 ** result.factor).toFixed(result.factor);
								if (debugging) console.log(`${result.name}:> ${result.key} Rohdaten ${rawValue} => ${value} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: value, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 5: {
								// für Versionsnummer
								const rawByte = ('0000' + modbus_data.readUInt16BE(i * 2).toString(16)).slice(-4);
								let versionString = 'V';
								for (let j = 0; j < rawByte.length; j++) {
									const value = rawByte[j];
									if (j > 0) {
										versionString = versionString + '.' + value;
									} else {
										versionString += value;
									}
								}
								if (debugging) console.log(`${result.name}:> ${result.key} Rohdaten ${rawByte} => ${versionString} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: versionString, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 6: {
								// für EinzelBytes (MSB -hex)
								const bitValue = modbus_data.readUInt8(i * 2).toString(16);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: bitValue, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 7: {
								// für EinzelBytes (LSB -hex)
								const bitValue = modbus_data.readUInt8(i * 2 + 1).toString(16);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: bitValue, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 8: {
								// für EinzelBytes (MSB -dez)
								const bitValue = modbus_data.readUInt8(i * 2).toString(10);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: bitValue, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
							case 9: {
								// für EinzelBytes (LSB -dez)
								const bitValue = modbus_data.readUInt8(i * 2 + 1).toString(10);
								if (debugging) console.log(`${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`);
								const jsonObj = { key: result.key, value: bitValue, unit: result.unit, name: result.name };
								jsonResult.push(jsonObj);
								break;
							}
						}
					}
				}
			}
		}
		return jsonResult;
	}

	request_frame(req) {
		// https://pysolarmanv5.readthedocs.io/en/latest/solarmanv5_protocol.html
		//const logger = 4072940982; // Inverter Serial Number
		const logger = this.loggerSn; // Fehlerabfangen falls leer

		const modbus = this.modbus_frame(req);
		const buffer = Buffer.alloc(11 + 15 + modbus.length + 2);
		buffer.writeUInt8(0xa5, 0); // Start
		buffer.writeUInt16LE(15 + modbus.length, 1); // Length
		buffer.writeUInt16LE(0x4510, 3); // Control Code
		buffer.writeUInt8(0x00, 4); // Reserved
		buffer.writeUInt8(req + 1, 5); // Request Number
		buffer.writeUint32LE(logger, 7); // Serial Number
		buffer.writeUInt8(0x02, 11); // Frame Type
		buffer.writeUInt16LE(0x00, 12); // Sensor Type
		buffer.writeUint32LE(0x00, 14); // Total Working Time
		buffer.writeUint32LE(0x00, 18); // Power On Time
		buffer.writeUint32LE(0x00, 22); // Offset Time

		modbus.copy(buffer, 26); // Modbus RTU

		buffer.writeUInt8(this.request_checksum(buffer), 11 + 15 + modbus.length); // SolarmanV5 Checksum
		buffer.writeUint8(0x15, 11 + 15 + modbus.length + 1); // End

		return buffer;
	}
	modbus_frame(i) {
		const firstregister = this.Registers[i].registerStart;
		const lastregister = this.Registers[i].registerEnd;
		//console.log(`modbus_frame ${i} 1.${firstregister}  2.${lastregister}`);
		const buffer = Buffer.alloc(8);
		buffer.writeUInt16BE(0x0103, 0);
		buffer.writeUInt16BE(firstregister, 2);
		buffer.writeUInt16BE(lastregister - firstregister + 1, 4);
		buffer.writeUInt16LE(this.modbus_checksum(buffer.subarray(0, 6)), 6);
		//console.log('modbus_frame: ', buffer);
		return buffer;
	}

	readRegisterset() {
		try {
			const jsonData = fs.readFileSync(fileRegister, { encoding: 'utf8', flag: 'r' });
			this.Registers = JSON.parse(jsonData); //now it is an object
		} catch (err) {
			console.error(err);
			throw new MyError({ status: 400, message: `Cannot read JSON file: ${fnRegister}` });
		}
	}
	readCoilset() {
		//console.log('(f) readCoilset: Try to read.');
		try {
			const jsonData = fs.readFileSync(fileCoils, { encoding: 'utf8', flag: 'r' });
			this.Coils = JSON.parse(jsonData); //now it is an object
		} catch (err) {
			console.error(err);
			throw new MyError({ status: 400, message: `Cannot read JSON file: ${fnCoils}` });
		}
	}

	// ==== Helper ====
	modbus_checksum(buffer) {
		let crc = 0xffff;
		let odd;
		for (let i = 0; i < buffer.length; i++) {
			crc = crc ^ buffer[i];
			for (let j = 0; j < 8; j++) {
				odd = crc & 0x0001;
				crc = crc >> 1;
				if (odd) {
					crc = crc ^ 0xa001;
				}
			}
		}
		return crc;
	}
	request_checksum(buffer) {
		let crc = 0;
		for (let i = 1; i < buffer.length - 2; i++) {
			crc += buffer[i] & 255;
		}
		return crc & 255;
	}
	sec2Time(totalSeconds) {
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds - hours * 3600) / 60);
		const seconds = totalSeconds - hours * 3600 - minutes * 60;
		let result = hours < 10 ? '0' + hours : hours;
		result += ':' + (minutes < 10 ? '0' + minutes : minutes);
		result += ':' + (seconds < 10 ? '0' + seconds : seconds);
		return result;
	}
	sec2DayTime(totalSeconds) {
		const days = Math.floor(totalSeconds / 86400);
		const hours = Math.floor((totalSeconds - days * 86400) / 3600);
		const minutes = Math.floor((totalSeconds - days * 86400 - hours * 3600) / 60);
		const seconds = totalSeconds - days * 86400 - hours * 3600 - minutes * 60;
		let result = days + 'd ';
		result += hours < 10 ? '0' + hours : hours;
		result += ':' + (minutes < 10 ? '0' + minutes : minutes);
		result += ':' + (seconds < 10 ? '0' + seconds : seconds);
		return result;
	}
	toDate(unixTimestamp) {
		return new Date(unixTimestamp * 1000);
	}
	isNumber(n) {
		return !isNaN(parseFloat(n)) && !isNaN(n - 0);
	}
	toHexString(byteArray) {
		return Array.from(byteArray, function (byte) {
			return ('0' + (byte & 0xff).toString(16)).slice(-2);
		}).join('');
	}
};
