/* jshint -W097 */ // jshint strict:false
/*jslint node: true */
'use strict';
/*
class MyError extends Error {
	constructor(err) {
		super(err.message);
		this.status = err.status;
	}
}
*/

module.exports = class idcCore {
	/**
	 * constructor
	 *
	 * @param log ioBroker Logging
	 * @param extDebugging enable extended debugging
	 */
	constructor(log, extDebugging) {
		this.log = log;
		this.extDebugging = extDebugging;
	}

	/**
	 * setLoggerSn
	 *
	 * @param loggerSn Serial Number
	 */
	setLoggerSn(loggerSn) {
		this.loggerSn = loggerSn;
	}

	/**
	 * setRegisters
	 *
	 * @param registers Register
	 */
	setRegisters(registers) {
		this.Registers = registers;
	}

	/**
	 * setCoils
	 *
	 * @param coils Coils
	 */
	setCoils(coils) {
		this.Coils = coils;
	}

	/**
	 * checkDataFrame
	 *
	 * @param data Buffer
	 * @returns register: reqNr,
				modbus: bufferInHex
	 */
	checkDataFrame(data) {
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] UTC-Time: ${this.localTime()}`);
		}
		/*
		Header
		The Header is always 11 bytes and is composed of:
		Start (one byte) – Denotes the start of the V5 frame. Always 0xA5.
		Length (two bytes) – Payload length
		Control Code (two bytes) – Describes the type of V5 frame. For Modbus RTU requests, the control code is 0x4510. For Modbus RTU responses, the control code is 0x1510.
		Serial (two bytes) – This field acts as a two-way sequence number. On outgoing requests, the first byte of this field is echoed back in the same position on incoming responses. pysolarmanv5 expoits this property to detect invalid responses. This is done by initialising this byte to a random value, and incrementing for each subsequent request. The second byte is incremented by the data logging stick for every response sent (either to Solarman Cloud or local requests).
		Logger Serial (four bytes) – Serial number of Solarman data logging stick
		*/
		const bufferInHex = Buffer.from(data);
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] Data Buffer ${this.toHexString(data)}`);
		}
		const startByte = parseInt(bufferInHex.readUInt8(0).toString(10)); // expected: 165(0xa5)
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] StartByte: ${startByte}`);
		}
		if (startByte == 170 || startByte == 65) {
			// 170(0xaa) => Communication with relay || 65(0x41) => Heartbeat
			return {
				register: -1,
				modbus: this.toHexString(data),
			};
		}
		const payloadLength = parseInt(bufferInHex.readUInt8(1).toString(10));
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] PayloadLength: ${payloadLength}`);
		}
		const dataLength = data.length;
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] dataLength: ${dataLength}`);
		}
		const checkSumFrame_received = bufferInHex.readUInt8(dataLength - 2).toString(16);
		const checkSumFrame_calculated = this.requestChecksum(data).toString(16);
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] CheckSum_Frame: ${checkSumFrame_received}|${checkSumFrame_calculated}`);
		}
		// Plausi
		if (checkSumFrame_received != checkSumFrame_calculated) {
			this.log.debug('[checkDataFrame] Frame CheckSum faulty!');
			this.log.silly(`[#checkDataFrame] DATA: ${data}`);
			return {
				register: -2,
				modbus: this.toHexString(data),
			};
			//throw new MyError({ status: 'EFRAMECHK', message: `Frame CheckSum faulty! ${checkSumFrame_received}|${checkSumFrame_calculated}` });
		}
		//
		const cntrlCode = bufferInHex.readUInt16BE(3); // expected: 4117 (0x1015) or 4165 (0x1045)
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] ControlCode: ${cntrlCode}`);
		}
		// Plausi
		if (cntrlCode != 4117 && cntrlCode != 4165) {
			this.log.debug('[checkDataFrame] ControlCode faulty!');
			return {
				register: -3,
				modbus: this.toHexString(data),
			};
			//throw new MyError({ status: 'ECNTRLCODE', message: `ControlCode faulty!` });
		}
		const reqNr = parseInt(bufferInHex.readUInt8(5).toString(10));
		const seqNr = parseInt(bufferInHex.readUInt8(6).toString(10));
		if (this.extDebugging) {
			this.log.silly(`[#checkDataFrame] RequestNumber|SequenzNumber: ${reqNr}|${seqNr}`);
		}
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
		if (payloadLength > 1) {
			const frameType = bufferInHex.readUInt8(11).toString(10); // expected: 2
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] FrameType: ${frameType}`);
			}
			const status = bufferInHex.readUInt8(12).toString(10); // expected: 1
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] Status: ${status}`);
			}
			const totalWorkingTime = bufferInHex.readUInt32LE(13).toString(10); // expected: 5133430 > 59d 09:57:10
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] totalWorkingTime: ${this.sec2DayTime(totalWorkingTime)}`);
			}
			const powerOnTime = bufferInHex.readUInt32LE(17).toString(10); // expected: 2373 > 00:39:33
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] powerOnTime: ${this.sec2Time(powerOnTime)}`);
			}
			const offsetTime = bufferInHex.readUInt32LE(21).toString(10); // expected: 1667756763 > Sun Nov 06 2022 18:46:03
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] offsetTime: ${this.toDate(offsetTime)}`);
			}
			const captureData = parseInt(totalWorkingTime) + parseInt(offsetTime);
			if (this.extDebugging) {
				this.log.silly(`[##checkDataFrame] CaptureData: ${this.toDate(captureData)}`);
			}
			// Modbus
			const checkSumModbus_received = bufferInHex.readUInt8(dataLength - 3).toString(16);
			const checkSumModbus_calculated = this.modbusChecksum(
				bufferInHex.subarray(25, bufferInHex.length - 3),
			).toString(16);
			if (this.extDebugging) {
				this.log.silly(
					`[##checkDataFrame] CheckSum_Modbus: ${checkSumModbus_received}|${checkSumModbus_calculated}`,
				);
			}
			// Plausi
			/*
			if (checkSumModbus_received != checkSumModbus_calculated) {
				this.log.debug('[checkDataFrame] CheckSum Modbus faulty!');
				if (parseInt(offsetTime) < 1) {
					this.log.silly('[##checkDataFrame] checkDataFrame Offset Time is invalid!');
					//throw new MyError({ status: 'EOTIME', message: `Offset Time is invalid` });
				}
				return {
					register: -4,
					modbus: this.toHexString(data),
				};
			}
			*/

			return {
				register: reqNr - 10,
				modbus: bufferInHex.subarray(25, bufferInHex.length - 3),
			};
		}
	}

	/**
	 * readCoils
	 *
	 * @param data Object
	 * @returns jsonResult Array
	 */
	readCoils(data) {
		const debugging = false;
		const jsonResult = [];
		//
		if (data.register > 0 && data.register <= Object.keys(this.Registers).length) {
			const startCoil = this.Registers[data.register - 1].registerStart;
			const expectedLen =
				(this.Registers[data.register - 1].registerEnd - this.Registers[data.register - 1].registerStart + 2) *
				2;
			const modbus_data = data.modbus.subarray(3, data.modbus.length - 1);
			if (this.extDebugging) {
				this.log.silly(`[#readCoils] RegisterRange: ${JSON.stringify(this.Registers[data.register - 1])}`);
				this.log.silly(
					`[#readCoils] Startcoil: ${startCoil} ExpectedLength: ${expectedLen} ModbusLength: ${modbus_data.length}`,
				);
			}
			if (modbus_data.length == expectedLen) {
				for (let i = 0; i < modbus_data.length / 2; i++) {
					const resultFilter = this.Coils.filter(obj => {
						return obj.register === this.Registers[data.register - 1].registerStart + i;
					});
					if (resultFilter.length > 0) {
						for (let j = 0; j < resultFilter.length; j++) {
							const result = resultFilter[j];
							if (this.extDebugging) {
								this.log.silly(`[#readCoils] Result: ${JSON.stringify(result)} > [${i}]`);
							}
							switch (result.rules) {
								case 0: {
									// raw_signed
									const bitValue = modbus_data.readInt16BE(i * 2).toString(10);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [0] [posBuffer:${i * 2}] ${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: bitValue,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 1: {
									// for 16-bit-unsigned Values
									const value = (modbus_data.readUInt16BE(i * 2) * 10 ** -result.factor).toFixed(
										result.factor,
									);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [1] [posBuffer:${i * 2}] ${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: value,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 2: {
									// for 16-bit-signed Values
									const value = (modbus_data.readInt16BE(i * 2) * 10 ** -result.factor).toFixed(
										result.factor,
									);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [2] [posBuffer:${i * 2}] Rawdata: ${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: value,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 3: {
									// for 32-bit-unsigned Values
									const low_word = modbus_data.readUInt16BE(i * 2);
									const high_word = modbus_data.readUInt16BE((i + 1) * 2);
									const value = ((low_word + high_word * 65536) * 10 ** -result.factor).toFixed(
										result.factor,
									);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [3] [posBuffer:${i * 2}] ${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: value,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 4: {
									// for 32-bit-signed Values
									const low_word = modbus_data.readUInt16BE(i * 2);
									const high_word = modbus_data.readInt16BE((i + 1) * 2);
									const value = ((low_word + high_word * 65536) * 10 ** -result.factor).toFixed(
										result.factor,
									);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [4] [posBuffer:${i * 2}] ${result.name}:> ${result.key} => ${value} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: value,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 5: {
									// Serialnumber
									let serialnr = 0;
									for (j = 0; j < 10; j++) {
										serialnr += (modbus_data.readUInt8(i * 2 + j) - 48) * 10 ** (9 - j);
									}
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [5] [posBuffer:${i * 2}] SerialNumber: ${serialnr}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: serialnr,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 6: {
									// Temperature
									const rawValue = modbus_data.readUInt16BE(i * 2);
									const value = ((rawValue - 1000) * 10 ** -result.factor).toFixed(result.factor);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [6] [posBuffer:${i * 2}] ${result.name}:> ${result.key} Rohdaten ${rawValue} => ${value} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: value,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 7: {
									// Versionsnumber
									const rawByte = `0000${modbus_data.readUInt16BE(i * 2).toString(16)}`.slice(-4);
									let versionString = 'V';
									for (let j = 0; j < rawByte.length; j++) {
										const value = rawByte[j];
										if (j > 0) {
											versionString = `${versionString}.${value}`;
										} else {
											versionString += value;
										}
									}
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [7] [posBuffer:${i * 2}] ${result.name}:> ${result.key} Rohdaten ${rawByte} => ${versionString} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: versionString,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 8: {
									// SingleBytes (MSB)
									const rawData = modbus_data.readUInt8(i * 2);
									const bitValue = modbus_data.readUInt8(i * 2).toString(10);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [8] [posBuffer:${i * 2}] Rawdata: ${rawData}; ${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: bitValue,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
								case 9: {
									// SingleBytes (LSB)
									const rawData = modbus_data.readUInt8(i * 2 + 1);
									const bitValue = modbus_data.readUInt8(i * 2 + 1).toString(10);
									if (debugging) {
										console.log(
											`Register ${startCoil + i} [9] [posBuffer:${i * 2 + 1}] Rawdata: ${rawData}; ${result.name}:> ${result.key} => ${bitValue} ${result.unit} # ${result.factor}`,
										);
									}
									const jsonObj = {
										key: result.key,
										value: bitValue,
										unit: result.unit,
										name: result.name,
									};
									jsonResult.push(jsonObj);
									break;
								}
							}
						}
					}
				}
			}
		}
		return jsonResult;
	}

	/**
	 * requestFrame
	 *
	 * @param req Request Number
	 * @param modbus Buffer
	 * @returns Buffer
	 */
	requestFrame(req, modbus) {
		// https://pysolarmanv5.readthedocs.io/en/latest/solarmanv5_protocol.html
		const logger = this.loggerSn; // LoggerSerialNr
		const buffer = Buffer.alloc(11 + 15 + modbus.length + 2); // 36
		buffer.writeUInt8(0xa5, 0); // Start
		buffer.writeUInt16LE(15 + modbus.length, 1); // Length
		buffer.writeUInt16LE(0x4510, 3); // Control Code
		buffer.writeUInt8(req + 10, 5); // Request number, Shift + 10######
		buffer.writeUint32LE(logger, 7); // Serial Number
		buffer.writeUInt8(0x02, 11); // Frame Type
		buffer.writeUInt16LE(0x00, 12); // Sensor Type
		buffer.writeUint32LE(0x00, 14); // Total Working Time
		buffer.writeUint32LE(0x00, 18); // Power On Time
		buffer.writeUint32LE(0x00, 22); // Offset Time
		modbus.copy(buffer, 26); // Modbus RTU
		buffer.writeUInt8(this.requestChecksum(buffer), 11 + 15 + modbus.length); // SolarmanV5 Checksum
		buffer.writeUint8(0x15, 11 + 15 + modbus.length + 1); // End
		return buffer;
	}

	/**
	 * modbusFrame
	 *
	 * @param i Register Number
	 * @returns Buffer
	 */
	modbusFrame(i) {
		const firstregister = this.Registers[i - 1].registerStart;
		const lastregister = this.Registers[i - 1].registerEnd;
		const buffer = Buffer.alloc(8);
		buffer.writeUInt16BE(0x0103, 0);
		buffer.writeUInt16BE(firstregister, 2);
		buffer.writeUInt16BE(lastregister - firstregister + 2, 4); // Two more register due to double buffer access!
		buffer.writeUInt16LE(this.modbusChecksum(buffer.subarray(0, 6)), 6);
		return buffer;
	}
	/**
	 * modbusReadFrame
	 *
	 * @param startregister Register Number
	 * @returns Buffer
	 */
	modbusReadFrame(startregister) {
		const buffer = Buffer.alloc(8);
		buffer.writeUInt16BE(0x0103, 0); // Read
		buffer.writeUInt16BE(startregister, 2);
		buffer.writeUInt16BE(0x0001, 4);
		buffer.writeUInt16LE(this.modbusChecksum(buffer.subarray(0, 6)), 6);
		return buffer;
	}

	/**
	 * modbusWriteFrame
	 *
	 * @param startregister Register Number
	 * @param data Buffer
	 * @returns Buffer
	 */
	modbusWriteFrame(startregister, data) {
		const data_length = data.length;
		const buffer = Buffer.alloc(data_length * 2 + 9);
		buffer.writeUInt16BE(0x0110, 0); // Write
		buffer.writeUInt16BE(startregister, 2);
		buffer.writeUInt16BE(data.length, 4);
		buffer.writeUInt8(data.length * 2, 6);

		for (let i = 0; i < data.length; i++) {
			buffer.writeUInt16BE(data[i], i * 2 + 7);
		}

		buffer.writeUInt16LE(this.modbusChecksum(buffer.subarray(0, 2 * data_length + 7)), 2 * data_length + 7);
		return buffer;
	}

	// ==== Helper ====
	/**
	 * @param buffer Buffer
	 * @returns crc number
	 */
	modbusChecksum(buffer) {
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
	/**
	 * @param buffer Buffer
	 * @returns crc number
	 */
	requestChecksum(buffer) {
		let crc = 0;
		for (let i = 1; i < buffer.length - 2; i++) {
			crc += buffer[i] & 255;
		}
		return crc & 255;
	}
	/**
	 *
	 * @param totalSeconds number
	 * @returns result string
	 */
	sec2Time(totalSeconds) {
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds - hours * 3600) / 60);
		const seconds = totalSeconds - hours * 3600 - minutes * 60;
		let result = hours < 10 ? `0${hours}` : hours;
		result += `:${minutes < 10 ? `0${minutes}` : minutes}`;
		result += `:${seconds < 10 ? `0${seconds}` : seconds}`;
		return result;
	}
	/**
	 * @param totalSeconds number
	 * @returns result string
	 */
	sec2DayTime(totalSeconds) {
		const days = Math.floor(totalSeconds / 86400);
		const hours = Math.floor((totalSeconds - days * 86400) / 3600);
		const minutes = Math.floor((totalSeconds - days * 86400 - hours * 3600) / 60);
		const seconds = totalSeconds - days * 86400 - hours * 3600 - minutes * 60;
		let result = `${days}d `;
		result += hours < 10 ? `0${hours}` : hours;
		result += `:${minutes < 10 ? `0${minutes}` : minutes}`;
		result += `:${seconds < 10 ? `0${seconds}` : seconds}`;
		return result;
	}
	/**
	 * @param unixTimestamp number
	 */
	toDate(unixTimestamp) {
		return new Date(unixTimestamp * 1000);
	}
	/**
	 * @returns string
	 */
	localTime() {
		const jetzt = Date.now();
		const totalSeconds = Math.trunc(jetzt / 1000);
		const milliSeconds = jetzt - totalSeconds * 1000;
		const days = Math.floor(totalSeconds / 86400);
		const hours = Math.floor((totalSeconds - days * 86400) / 3600);
		const minutes = Math.floor((totalSeconds - days * 86400 - hours * 3600) / 60);
		const seconds = totalSeconds - days * 86400 - hours * 3600 - minutes * 60;
		let result = '';
		result += hours < 10 ? `0${hours}` : hours;
		result += `:${minutes < 10 ? `0${minutes}` : minutes}`;
		result += `:${seconds < 10 ? `0${seconds}` : seconds}`;
		result += `.${milliSeconds < 100 ? `00${milliSeconds}` : milliSeconds}`;
		return result;
	}
	/**
	 * @param n number
	 */
	isNumber(n) {
		return !isNaN(parseFloat(n)) && !isNaN(n - 0);
	}
	/**
	 * @param byteArray Buffer
	 */
	toHexString(byteArray) {
		return Array.from(byteArray, function (byte) {
			return `0${(byte & 0xff).toString(16)}`.slice(-2);
		}).join('');
	}
};
