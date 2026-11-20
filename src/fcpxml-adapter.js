const { ScanError, fileErrorCode, buildInventory } = require('./fcpxml-scan-core');
const { createFcpXmlScanner } = require('./fcpxml-scan-controller');

// Synchronous source-string diagnostics retain their existing interface. The
// production filesystem scan and source verification always run in a worker.
function scanXml(xml) { return buildInventory(xml).scan; }
let scanner;
const defaultScanner = () => scanner || (scanner = createFcpXmlScanner());
const scanFcpXml = (selectedPath, options) => defaultScanner().scan(selectedPath, options);
const verifyFcpXmlSource = (selectedPath, sourceHash, options) => defaultScanner().verifySource(selectedPath, sourceHash, options);

module.exports = { ScanError, fileErrorCode, scanFcpXml, scanXml, verifyFcpXmlSource, createFcpXmlScanner };
