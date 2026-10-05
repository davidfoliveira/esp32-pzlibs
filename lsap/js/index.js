'use strict';
// Entry point of the LSAP package: the codec + encryption layer, and the gateway-side endpoint.
const lsap = require('./lsap');
const { Link } = require('./link');

module.exports = { ...lsap, Link };
