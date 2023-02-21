![Logo](admin/deyeidc.png)

# ioBroker.deyeidc

[![NPM version](https://img.shields.io/npm/v/iobroker.deyeidc.svg)](https://www.npmjs.com/package/iobroker.deyeidc)
[![Downloads](https://img.shields.io/npm/dm/iobroker.deyeidc.svg)](https://www.npmjs.com/package/iobroker.deyeidc)
![Number of Installations](https://iobroker.live/badges/deyeidc-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/deyeidc-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.deyeidc.png?downloads=true)](https://nodei.co/npm/iobroker.deyeidc/)

**Tests:** ![Test and Release](https://github.com/rasyxh/ioBroker.deyeidc/workflows/Test%20and%20Release/badge.svg)

## deyeidc adapter for ioBroker

Data Collector vor Deye-compatible Inverter

## Developer manual

This adapter requires three control files: The 'register.json' contains the ranges of the Modbus registers that are to be read out. A second 'coils.json' describes exactly which ports are to be read out according to which procedure for which data point. The third file 'compute.json' contains the calculation rule according to which values that cannot be read out are to be calculated within the adapter.

### DISCLAIMER

Please make sure that you consider copyrights and trademarks when you use names or logos of a company and add a disclaimer to your README.
You can check other adapters for examples or ask in the developer community. Using a name or logo of a company without permission may cause legal problems for you.

### Getting started

This adapter makes it possible to read out data from an inverter in the local network. This data is retrieved via the known Modbus ports and stored in the data points.
For this, only the IP of the inverter and the serial number of the logger must be entered. If the port differs from the default value, it can also be adjusted. 60 seconds has been preset as a practicable value for the sampling rate.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

-   (raschy) initial release

## License

MIT License

Copyright (c) 2023 raschy <raschy@gmx.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
