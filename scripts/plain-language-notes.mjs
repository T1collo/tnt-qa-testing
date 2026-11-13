// Rewrites the findings column on both result sheets in plain, non-specialist English,
// and moves the original wording into an adjacent "Technical detail" column so nothing
// is lost for the engineers.
//
// Run: node scripts/plain-language-notes.mjs
import ExcelJS from 'exceljs';
import path from 'node:path';

const BOOK = path.join(import.meta.dirname, '..', 'docs', 'Sheet1_Error_Code_Tests_DocsVsSystem.xlsx');

// ---------------------------------------------------------------- error-code suite
const PLAIN_EC = {
  'TC-S1-001': 'Works correctly. A broken XML file is refused.',
  'TC-S1-002': 'Partly works. Broken data is refused, but the system uses a different error name than the guide promises. Worse, when the text is badly mangled it returns no error name at all - just a raw technical message. Partner software looking for the documented name will not find it.',
  'TC-S1-003': 'Works correctly. A message with its main content missing is refused.',
  'TC-S1-004': 'Works correctly. A message where the list of events is the wrong shape is refused.',
  'TC-S1-005': 'Gap. Older XML files carry a separate "envelope" section. The system never checks that section on its own - a fault there is reported as a general XML problem, so the partner is not told the envelope is what is wrong.',
  'TC-S1-006': 'Mostly works. Oversized messages are blocked at both size limits, which is the important part. Only the status number differs from the guide for the smaller limit.',
  'TC-S1-007': 'Works correctly, and the limit is exact: 50,000 items are accepted and 50,001 are refused.',
  'TC-S1-008': 'Works correctly. An expiry date written in the wrong format is refused.',
  'TC-S1-009': 'Works correctly. A product code with the wrong number of digits is refused.',
  'TC-S1-010': 'Works correctly. An event dated in the future is refused, and the 5-minute grace period is exactly as documented.',
  'TC-S1-011': 'Works correctly. An event missing required information is refused, and the reply names the missing field.',
  'TC-S1-012': 'Works correctly in practice. Sending the same event twice is blocked. The only difference is the status number: the system returns 409, the guide says 400. 409 is the more standard choice, so the guide should be corrected rather than the system.',
  'TC-S1-013': 'Works correctly in practice. Re-sending the same information under a new reference is still recognised and blocked. Same status-number difference as the row above.',
  'TC-S1-014': 'Works correctly. Listing the same pack twice in one event is refused.',
  'TC-S1-015': 'Works correctly. Impossible sensor readings, such as a minimum higher than the maximum, are refused.',
  'TC-S1-016': 'Works correctly. A correction dated before the event it corrects is refused.',
  'TC-S1-017': 'Works correctly. A correction pointing at an event that does not exist is refused.',
  'TC-S1-018': 'Works correctly. A correction that quietly changes the original details is refused.',
  'TC-S1-019': 'Works correctly. A correction giving a reason outside the approved list is refused.',
  'TC-S1-020': 'Works correctly. A correction pointing at a replacement event that does not exist is refused.',
  'TC-S1-021': 'Important difference. The guide says a pack nobody has registered should be refused outright. In practice the system accepts it, stores it, and only attaches a warning. Unregistered packs can therefore enter the national system.',
  'TC-S1-022': 'Important difference. Same as above but for places: an unregistered location is accepted and stored with only a warning, where the guide says it should be refused.',
  'TC-S1-023': 'Could not be tested. The test system has no example of a location that is registered but switched off, so there was nothing to trigger the rule. Test data needs to be set up first.',
  'TC-S1-024': 'Works correctly. A product code whose built-in self-check fails is refused.',
  'TC-S1-025': 'Significant gap. Location codes are never checked for typos. We sent three obviously wrong location codes - wrong length, letters instead of numbers, and a failed self-check - and the system accepted all three without complaint. Product codes and pallet codes ARE checked, so locations have been missed.',
  'TC-S1-026': 'Gap. Pallet and case codes are checked, but only for having the right number of digits, never for the built-in self-check digit. The specific error the guide names is never used.',
  'TC-S1-027': 'Works correctly. An unrecognised batch number is accepted with a warning, and the event is stored, exactly as intended.',
  'TC-S1-028': 'Works correctly. A pack seen at a location different from where it was last recorded raises a warning.',
  'TC-S1-029': 'Works correctly. Product moving without the required regulatory approval raises a warning.',
  'TC-S1-030': 'Works correctly. An inspection event sent by someone who is not a regulator raises a warning. Only one error name is used, which answers the question raised in the original notes.',
  'TC-S1-031': 'Works correctly. Product expiring within 90 days raises an early warning.',
  'TC-S1-032': 'Gap. There is no specific "this pack was already given to a patient" warning. We set this up cleanly and the system either gave a general state warning or blocked it as a repeat message. The warning the guide names is never used.',
  'TC-S1-033': 'Works correctly. An event on a pack already destroyed raises a warning.',
  'TC-S1-034': 'Works correctly, with a caveat: the check only looks at whether one state can legally follow another. A completely meaningless state value is accepted without comment.',
  'TC-S1-035': 'Works correctly, with a caveat: the check only asks whether the step is a recognised word, not whether it makes sense for that kind of pack.',
  'TC-S1-036': 'Gap. The guide lists a separate warning for acting on a pack in a final state. In practice the system reuses the "already destroyed" warning, so the two warnings the guide keeps apart are actually one.',
  'TC-S1-037': 'Gap. The guide lists a separate warning for an illogical pallet/case structure. In practice the system just reports that it cannot find the parent container, so the structural problem itself is never identified.',
  'TC-S1-038': 'Works correctly when packing. Note it does not trigger when unpacking - that case produces a different warning instead.',
  'TC-S1-039': 'Works correctly. Putting a pack into a second container while it is still in the first raises a warning.',
  'TC-S1-040': 'Gap. The guide lists a general "events happened in an impossible order" warning. The system only ever gives specific warnings such as "received without being shipped", never the general one.',
  'TC-S1-041': 'Important difference, in the safer direction. The guide says using a pallet code when dispensing should be accepted with a warning. The system refuses it outright instead. Note the detail is buried in a third kind of reply that partner software also has to know how to read.',
  'TC-S1-042': 'Works correctly. Product past its expiry date raises a warning.',
  'TC-S1-043': 'Could not be tested. No product in the test system is under an active recall, so there was nothing to trigger the rule. Test data needs to be set up first.',
  'TC-S1-044': 'Works correctly. Receiving goods with no matching dispatch raises a warning.',
  'TC-S1-045': 'Works correctly. Unpacking a container that was never packed raises a warning.',
  'TC-S1-046': 'Works correctly, and the limit is exact: just under 7 days is clean, just over 7 days raises a warning.',
  'TC-S1-047': 'Works correctly. Packing items that were never registered raises a warning.',
  'TC-S1-048': 'Works correctly. Shipping items that were never registered raises a warning.',
  'TC-S1-049': 'Gap. Reusing the same pallet code twice in one message should be flagged. We tried two different ways of doing this and the warning never appeared.',
  'TC-S1-050': 'Gap. Reusing a pallet code that is already in use from an earlier message should be flagged. We allowed extra time for processing and the warning still never appeared, which suggests pallet reuse is not tracked between messages at all.',
  'TC-S1-051': 'Works correctly. A correction that claims to fix data but names no replacement raises a warning.',
  'TC-S1-052': 'Works correctly. A correction with no reason given raises a warning.',
};

// ---------------------------------------------------------------- edge & abnormal suite
const PLAIN_EDGE = {
  'EC-A01': 'Answers your question directly. The second batch number is refused - the system says "you have already sent this". So a pack can never be registered twice, which is good. But the block happens because the system compares the pack code and the step only; the batch number is not part of that comparison. Two consequences: a genuine correction to a mis-typed batch cannot be made this way, and the partner sees a confusing "duplicate" message rather than "that pack already has a batch".',
  'EC-A02': 'Same answer when both attempts are in one message: the whole message is refused. Consistent with the row above.',
  'EC-A03': 'Works correctly. Sending the identical message twice is recognised and refused.',
  'EC-A04': 'Works correctly. This is the control test: many packs sharing one batch in a single event is fine. It confirms the rule limits batches per event, not how many packs you can include.',
  'EC-A05': 'Blocked, which is the right outcome. But it is blocked by the same "you already sent this" check rather than by any rule about the pack having already left the warehouse. The lifecycle rule itself is never actually exercised.',
  'EC-A06': 'Real problem. A pack was registered under one batch, then shipped claiming a completely different batch - and the system accepted it. It did raise a warning, but only because the batch was unrecognised, not because it contradicted what was said earlier. Contradictory information about the same pack is not detected.',
  'EC-A07': 'Works correctly. The same serial number under two different products is genuinely two different packs, and both were accepted. This confirms the system is not confusing packs by serial number alone.',

  'EC-B01': 'Real problem. The guide says every registration must include the batch number and expiry date. We sent one with that whole section missing and the system accepted it silently - no error, no warning.',
  'EC-B02': 'Real problem. Same as above with the section present but empty.',
  'EC-B03': 'Real problem, and it opens a loophole. A blank batch number is accepted, and the usual "unrecognised batch" check does not run at all. Sending a blank batch is therefore a way to skip batch checking entirely.',
  'EC-B04': 'Real problem. Same loophole as the row above when the batch is sent as an explicit "nothing" value.',
  'EC-B05': 'Real problem. The expiry date is required at registration but leaving it out is accepted silently. Expiry drives the "expiring soon" and "expired" warnings, so those safety warnings are quietly switched off for any pack registered this way.',
  'EC-B06': 'Needs a decision, not yet a finding. Missing country of origin was accepted. The guide only requires it for imported products, and the test system has no imported-product example, so this could not be settled here. Needs test data for an imported product.',
  'EC-B07': 'Problem. We sent a country of origin that is not a real country code and it was accepted without question. This is a field the regulator relies on.',
  'EC-B08': 'Real problem. The guide says every event must state the location, because that is what ties the record to the right regulatory area. We left it out and the event was accepted.',
  'EC-B09': 'Works correctly. The optional scan-point field can be left out, exactly as the guide allows.',
  'EC-B10': 'Worth noting. An event with no status was accepted. The rules that track a pack through its life depend on that status, so events without one are effectively invisible to those checks.',
  'EC-B11': 'Problem. The time-zone field is listed as required but leaving it out was accepted.',
  'EC-B12': 'Works correctly. An unrecognised extra field was accepted and ignored, which is the right behaviour - it means future additions will not break existing partners.',
  'EC-B13': 'Works correctly. An event listing no packs at all is refused.',
  'EC-B14': 'Works correctly. Same as above, handled consistently.',

  'EC-C01': 'Works correctly and as promised. Events sent out of order are accepted - a partner whose earlier message was delayed is not penalised.',
  'EC-C02': 'Works correctly. Two different packs registered at the exact same moment are both accepted, which is normal for a production line.',
  'EC-C03': 'Works correctly. A time given in world time with a local time zone alongside it is valid and accepted.',
  'EC-C04': 'Problem. We sent a time zone that does not exist anywhere on earth and it was accepted. This field is not being checked at all.',
  'EC-C05': 'Needs checking, potentially serious. The partner supplied their own "when we recorded this" timestamp, dated a year ago, and it was accepted. That timestamp is supposed to be set by the system, not the sender - it is the audit trail. We cannot tell from outside whether the system kept the partner value or overwrote it. Worth confirming, because a sender-controlled audit date would be a serious integrity issue.',
  'EC-C06': 'Works correctly. A date sent as a raw number instead of a proper date is refused.',
  'EC-C07': 'Works correctly. The 5-minute future limit is accurate. Note the test machine clock differs from the server by about 1.3 seconds, so tests within about 2 seconds of the boundary cannot be trusted either way.',

  'EC-D01': 'Works correctly. A message containing no events is refused.',
  'EC-D02': 'Difference from the guide. The guide describes a "partly accepted" reply where the good events are kept and the bad ones are reported. In practice one bad event causes the entire message to be refused and nothing is stored. We could not produce the partly-accepted reply in any test, so it appears not to exist.',
  'EC-D03': 'Works correctly. When one event is fine and another only warrants a warning, both are stored and the warning is returned.',
  'EC-D04': 'Works correctly. Both accepted ways of writing the file header work.',
  'EC-D05': 'Works correctly. A file sent as the wrong type is refused with the right status.',
  'EC-D06': 'Minor difference. The guide explicitly says the long-form wording is not allowed in the newer format, but the system accepts it anyway. The system is more forgiving than the guide - either the guide or the system should change so partners are not misled.',
  'EC-D07': 'Serious problem. When the same pack code is sent in capital letters, the system treats it as a completely different pack and accepts it. One physical pack can therefore appear twice in the national register under two spellings. Note that extra spaces around a code ARE handled correctly, so the tidying-up step exists - it just misses capital letters.',
  'EC-D08': 'Works correctly. Extra spaces around a pack code are stripped, and we proved it resolves to the same pack.',
  'EC-D09': 'Worth noting. A batch number containing accents and an emoji was accepted. Whether it is stored and returned unchanged cannot be checked from outside.',
  'EC-D10': 'Problem. A batch number 1,000 characters long was accepted. The international standard allows 20 characters, so this batch number could never be printed on an actual barcode.',
  'EC-D11': 'Problem. We sent a message that contradicted itself - it stated the step twice with two different values. Instead of refusing it, the system silently picked the second one and stored the event as a shipment when the message also said it was a registration. A self-contradictory message should be refused, not quietly reinterpreted.',

  'EC-E01': 'Works correctly. Registering by quantity rather than by individual pack is supported.',
  'EC-E02': 'Works correctly. A quantity of zero is refused.',
  'EC-E03': 'Works correctly. A negative quantity is refused.',
  'EC-E04': 'Serious problem. The guide says dispensing must always be done one pack at a time, so each individual pack is accounted for. The system accepted a bulk dispense by quantity instead, and confirmed it had handled it that way. This defeats the whole point of tracking individual packs to the patient.',

  'EC-F01': 'Problem. We told the system a container was packed inside itself, which is physically impossible, and it was accepted. The only warning raised was an unrelated one about not finding the container.',
  'EC-F02': 'Works correctly. Packing a container with nothing in it is refused.',
  'EC-F03': 'Works correctly. Putting one pack into two containers at once is detected and warned about, though only as a warning rather than a refusal.',
  'EC-F04': 'Problem. The guide sets a maximum of three levels of packing - pack, case, pallet. We built a fourth level and it was accepted with no complaint.',
  'EC-F05': 'Works correctly. Listing the same item twice inside one container is refused.',
  'EC-F06': 'Works correctly. Unpacking something that was never packed raises a warning.',
  'EC-F07': 'Works correctly. Trying to pack a pack that has already been given to a patient raises a warning, though only a warning.',

  'EC-G01': 'Works correctly. A manufacturer can use the manufacturer service.',
  'EC-G02': 'Works correctly. A manufacturer is refused access to the distributor service.',
  'EC-G03': 'Works correctly. A manufacturer is refused access to the facility service.',
  'EC-G04': 'Works correctly. A distributor is refused access to the manufacturer service.',
  'EC-G05': 'Works correctly. A distributor can use the distributor service.',
  'EC-G06': 'Works correctly. A distributor is refused access to the facility service.',
  'EC-G07': 'Works correctly. A hospital or pharmacy is refused access to the manufacturer service.',
  'EC-G08': 'Works correctly. A hospital or pharmacy is refused access to the distributor service.',
  'EC-G09': 'Works correctly. A hospital or pharmacy can use the facility service.',
  'EC-G10': 'Works correctly. A manufacturer cannot reach the dispensing service.',
  'EC-G11': 'Works correctly. A request with no login key is refused.',
  'EC-G12': 'Works correctly. A request with a made-up login key is refused, and the reply gives nothing away about why.',
  'EC-G13': 'Gap. Access is controlled by which service you can reach, but not by what you are allowed to do once inside. A hospital was able to register brand-new product, which only a manufacturer should ever do.',
  'EC-G14': 'Gap. Same as above - a distributor was able to register brand-new product.',

  'EC-H01': 'Most serious finding. A pharmacy was able to dispense a pack the system has never heard of, and the system recorded it as a perfectly normal dispense with no warning at all. In the real world this is exactly how a counterfeit or stolen pack reaches a patient. This is the single most important check in the whole system and it does not run.',
  'EC-H02': 'Equally serious. A pack that had already been recorded as destroyed was dispensed successfully, with no warning. Destroyed stock must never reach a patient.',
  'EC-H03': 'Works correctly. Shipping the same pack twice raises a warning, though only a warning.',
  'EC-H04': 'Works correctly. Receiving the same pack twice raises a warning, though only a warning.',
  'EC-H05': 'Gap. A pack that had already been given to a patient was sent back into the supply chain and nothing was flagged. There is no rule stopping dispensed product from re-entering circulation.',
  'EC-H06': 'Blocked, but for the wrong reason - and this matters. Dispensing the same pack to a second patient IS prevented, which is the outcome we want. However it is prevented by the general "you already sent this message" check, not by a rule about patient safety. The pharmacist sees a confusing "duplicate message" error instead of "this pack has already been given to a patient". It also means the protection depends on a mechanism that was never designed for this purpose.',
  'EC-H07': 'Blocked. Destroying the same pack twice is prevented, by the same general repeat-message check as the row above.',
  'EC-H08': 'Works correctly. Marking an already-dispensed pack as damaged raises a warning.',
  'EC-H09': 'Works correctly. Reporting an already-destroyed pack as stolen raises a warning.',
  'EC-H10': 'Works correctly. Shipping a pack from a place it was never delivered to raises a warning.',
};

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(BOOK);

function rewrite(sheet, idCol, noteCol, techCol, plainMap, label) {
  sheet.getCell(1, noteCol).value = 'What this means (plain English)';
  sheet.getCell(1, techCol).value = 'Technical detail';
  for (const c of [noteCol, techCol]) {
    sheet.getCell(1, c).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getCell(1, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF434343' } };
    sheet.getCell(1, c).alignment = { vertical: 'middle', wrapText: true };
  }
  sheet.getColumn(noteCol).width = 86;
  sheet.getColumn(techCol).width = 78;

  let done = 0, missing = [];
  sheet.eachRow((row, i) => {
    if (i === 1) return;
    const id = String(row.getCell(idCol).value || '').trim();
    const plain = plainMap[id];
    if (!plain) { if (id) missing.push(id); return; }
    const original = row.getCell(noteCol).value;
    row.getCell(techCol).value = typeof original === 'string' ? original : (original ?? '');
    row.getCell(techCol).alignment = { vertical: 'top', wrapText: true };
    row.getCell(noteCol).value = plain;
    row.getCell(noteCol).alignment = { vertical: 'top', wrapText: true };
    done++;
  });
  console.log(`${label}: ${done} rows rewritten${missing.length ? `, no plain text for: ${missing.join(', ')}` : ''}`);
}

rewrite(wb.worksheets[0], 1, 15, 17, PLAIN_EC, 'Error codes');
rewrite(wb.getWorksheet('Edge & Abnormal Cases'), 1, 12, 13, PLAIN_EDGE, 'Edge cases');

await wb.xlsx.writeFile(BOOK);
console.log(`saved -> ${BOOK}`);
