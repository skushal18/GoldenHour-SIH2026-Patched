/* ============================================================================
   The single list of case types.

   The ambulance app builds its dropdown from GET /api/v1/case-types, and the
   hospital dashboard uses the same list to turn a case_type_id back into words.
   Keep it here and both ends can never drift apart.
   ========================================================================== */

'use strict';

const CASE_TYPES = [
  { id: 1,  category: 'TRAUMA',     label: 'Road accident — multiple injuries',            quick: true,  short: 'Road accident' },
  { id: 2,  category: 'TRAUMA',     label: 'Head injury',                                  quick: true,  short: 'Head injury' },
  { id: 3,  category: 'TRAUMA',     label: 'Fall from height' },
  { id: 4,  category: 'TRAUMA',     label: 'Stab / gunshot / penetrating wound' },
  { id: 5,  category: 'TRAUMA',     label: 'Major burns' },
  { id: 6,  category: 'TRAUMA',     label: 'Crush injury / amputation' },
  { id: 7,  category: 'TRAUMA',     label: 'Suspected spinal injury' },

  { id: 8,  category: 'CARDIAC',    label: 'Chest pain / suspected heart attack',          quick: true,  short: 'Chest pain' },
  { id: 9,  category: 'CARDIAC',    label: 'Cardiac arrest — CPR in progress',             quick: true,  short: 'Cardiac arrest' },
  { id: 10, category: 'CARDIAC',    label: 'Irregular heartbeat / arrhythmia' },
  { id: 11, category: 'CARDIAC',    label: 'Heart failure / fluid in lungs' },

  { id: 12, category: 'STROKE',     label: 'Stroke / sudden weakness or slurred speech',   quick: true,  short: 'Stroke' },
  { id: 13, category: 'STROKE',     label: 'Suspected TIA (symptoms already settled)' },

  { id: 14, category: 'NEURO',      label: 'Seizure / fits' },
  { id: 15, category: 'NEURO',      label: 'Unresponsive — cause unknown' },

  { id: 16, category: 'RESP',       label: 'Severe breathlessness / asthma attack',        quick: true,  short: 'Breathless' },
  { id: 17, category: 'RESP',       label: 'COPD flare-up' },
  { id: 18, category: 'RESP',       label: 'Choking / blocked airway' },
  { id: 19, category: 'RESP',       label: 'Drowning' },

  { id: 20, category: 'METABOLIC',  label: 'Low blood sugar (hypoglycaemia)' },
  { id: 21, category: 'METABOLIC',  label: 'High blood sugar / DKA' },
  { id: 22, category: 'METABOLIC',  label: 'Heat stroke / severe dehydration' },

  { id: 23, category: 'OBSTETRIC',  label: 'Labour / delivery imminent' },
  { id: 24, category: 'OBSTETRIC',  label: 'Pregnancy emergency (bleeding, fits, high BP)' },
  { id: 25, category: 'OBSTETRIC',  label: 'Newborn in distress' },

  { id: 26, category: 'PAEDIATRIC', label: 'Sick child — high fever or fits' },
  { id: 27, category: 'PAEDIATRIC', label: 'Injured child' },

  { id: 28, category: 'POISONING',  label: 'Poisoning / overdose' },
  { id: 29, category: 'POISONING',  label: 'Snake bite / animal bite' },

  { id: 30, category: 'ALLERGY',    label: 'Severe allergic reaction (anaphylaxis)' },

  { id: 31, category: 'OTHER',      label: 'Heavy bleeding (not from injury)' },
  { id: 32, category: 'OTHER',      label: 'Psychiatric emergency' },
  { id: 33, category: 'OTHER',      label: 'Other emergency' }
];

const BY_ID = CASE_TYPES.reduce((map, t) => { map[t.id] = t; return map; }, {});

function findCaseType(id) {
  return BY_ID[Number(id)] || null;
}

function labelFor(id) {
  const t = findCaseType(id);
  return t ? t.label : 'Emergency';
}

function categoryFor(id) {
  const t = findCaseType(id);
  return t ? t.category : 'OTHER';
}

module.exports = { CASE_TYPES, findCaseType, labelFor, categoryFor };
