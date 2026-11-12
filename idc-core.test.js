'use strict';

const { expect } = require('chai');
const IdcCore = require('./lib/idc-core.js');

const log = { silly() {}, debug() {} };

function rtuResponse(core, slave, words) {
	const buf = Buffer.alloc(3 + words.length * 2 + 2);
	buf.writeUInt8(slave, 0);
	buf.writeUInt8(0x03, 1);
	buf.writeUInt8(words.length * 2, 2);
	words.forEach((w, i) => buf.writeUInt16BE(w, 3 + i * 2));
	buf.writeUInt16LE(core.modbusChecksum(buf.subarray(0, buf.length - 2)), buf.length - 2);
	return buf;
}

describe('idcCore Modbus frames', () => {
	it('builds the read frame for slave 1 as before', () => {
		const core = new IdcCore(log, false);
		core.setRegisters([{ registerStart: 59, registerEnd: 90 }]);
		expect(core.modbusFrame(1).toString('hex')).to.equal('0103003b0021f41f');
	});

	it('uses the configured slave id', () => {
		const core = new IdcCore(log, false);
		core.setSlaveId(5);
		core.setRegisters([{ registerStart: 59, registerEnd: 90 }]);
		const frame = core.modbusFrame(1);
		expect(frame[0]).to.equal(5);
		expect(core.modbusChecksum(frame.subarray(0, 6))).to.equal(frame.readUInt16LE(6));
		expect(core.modbusWriteFrame(40, [50])[0]).to.equal(5);
		expect(core.modbusReadFrame(0x17)[0]).to.equal(5);
	});

	it('writes a valid Modbus write frame', () => {
		const core = new IdcCore(log, false);
		const frame = core.modbusWriteFrame(40, [50]);
		expect(frame.subarray(0, 9).toString('hex')).to.equal('01100028000102' + '0032');
		expect(core.modbusChecksum(frame.subarray(0, 9))).to.equal(frame.readUInt16LE(9));
	});
});

describe('idcCore.extractRtuFrame', () => {
	let core;
	beforeEach(() => {
		core = new IdcCore(log, false);
		core.setSlaveId(1);
	});

	it('parses a response from the real converter (registers 59..60)', () => {
		const raw = Buffer.from('0103040002004c5a06', 'hex');
		const res = core.extractRtuFrame(raw);
		expect(res.consumed).to.equal(raw.length);
		expect(res.write).to.equal(false);
		// readCoils expects 3 header bytes, data and no CRC (modbus.length - 1 is cut)
		expect(res.modbus.subarray(3, res.modbus.length - 1).toString('hex')).to.equal('0002004c');
	});

	it('waits for more data on a truncated frame', () => {
		const raw = rtuResponse(core, 1, [1, 2, 3]);
		expect(core.extractRtuFrame(raw.subarray(0, 2))).to.equal(null);
		expect(core.extractRtuFrame(raw.subarray(0, raw.length - 1))).to.equal(null);
	});

	it('takes only the first frame when two arrive together', () => {
		const a = rtuResponse(core, 1, [1, 2]);
		const b = rtuResponse(core, 1, [3]);
		const res = core.extractRtuFrame(Buffer.concat([a, b]));
		expect(res.consumed).to.equal(a.length);
	});

	it('reports a CRC error', () => {
		const raw = rtuResponse(core, 1, [1, 2]);
		raw[3] ^= 0xff;
		expect(core.extractRtuFrame(raw).error).to.equal('CRC faulty');
	});

	it('reports a foreign slave', () => {
		const res = core.extractRtuFrame(rtuResponse(core, 2, [1]));
		expect(res.error).to.contain('slave');
	});

	it('reports a Modbus exception', () => {
		const raw = Buffer.from([1, 0x83, 0x02, 0, 0]);
		raw.writeUInt16LE(core.modbusChecksum(raw.subarray(0, 3)), 3);
		const res = core.extractRtuFrame(raw);
		expect(res.error).to.contain('exception 2');
		expect(res.consumed).to.equal(5);
	});

	it('recognises a write acknowledgement', () => {
		const raw = Buffer.alloc(8);
		core.modbusWriteFrame(40, [50]).copy(raw, 0, 0, 6);
		raw.writeUInt16LE(core.modbusChecksum(raw.subarray(0, 6)), 6);
		const res = core.extractRtuFrame(raw);
		expect(res.write).to.equal(true);
		expect(res.consumed).to.equal(8);
	});

	it('feeds readCoils the same way as the logger path', () => {
		core.setRegisters([{ registerStart: 59, registerEnd: 59 }]);
		core.setCoils([{ register: 59, rules: 1, key: 'A', name: 'A', unit: 'W', factor: 0 }]);
		const raw = rtuResponse(core, 1, [1234, 0]);
		const res = core.extractRtuFrame(raw);
		const values = core.readCoils({ register: 1, modbus: res.modbus });
		expect(values).to.deep.equal([{ key: 'A', value: '1234', unit: 'W', name: 'A' }]);
	});
});
