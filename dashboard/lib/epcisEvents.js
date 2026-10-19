// Pulls the events out of an EPCIS document, whichever form it was sent in (2.0 JSON-LD or
// 1.2 XML). Shared by the SQLite audit log (server) and the Run/Audit dialogs (client), so
// both read a document the same way.
const XML_EVENT = /<(ObjectEvent|AggregationEvent|TransactionEvent|TransformationEvent)\b[\s\S]*?<\/\1>/g;

function xmlValues(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1].trim());
}

function eventsFromBody(body) {
  if (!body) return [];
  try {
    const doc = JSON.parse(body);
    return (doc.epcisBody?.eventList || []).map((e) => ({
      eventID: e.eventID ?? null,
      type: e.type ?? null,
      bizStep: e.bizStep ?? null,
      parentID: e.parentID ?? null,
      epcList: e.epcList || [],
      childEPCs: e.childEPCs || [],
    }));
  } catch {
    return (body.match(XML_EVENT) || []).map((block) => ({
      eventID: xmlValues(block, "eventID")[0] ?? null,
      type: block.match(/^<(\w+)/)[1],
      bizStep: xmlValues(block, "bizStep")[0] ?? null,
      parentID: xmlValues(block, "parentID")[0] ?? null,
      epcList: xmlValues(xmlValues(block, "epcList").join(""), "epc"),
      childEPCs: xmlValues(xmlValues(block, "childEPCs").join(""), "epc"),
    }));
  }
}

function returnedEventIds(responseBody) {
  try {
    return JSON.parse(responseBody).event_ids || [];
  } catch {
    return [];
  }
}

module.exports = { eventsFromBody, returnedEventIds };
