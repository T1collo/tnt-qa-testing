// Appends created test entities (batch numbers, serials, SSCCs, shipment IDs, etc.)
// to a JSON log so they can be pulled into the QA tracking spreadsheet and reused
// or cleaned up later.
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', '..', 'run_data', 'created-entities.json');

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function logEntity(entry) {
  const log = readLog();
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
  console.log(`[datalog] ${entry.type}: ${entry.identifier}${entry.testId ? ` (from ${entry.testId})` : ''}`);
}

module.exports = { logEntity, readLog, LOG_PATH };
