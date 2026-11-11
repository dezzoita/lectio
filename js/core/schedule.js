// schedule.js — Dall'orario settimanale alla materia del momento.

export function hmToMin(hm) {
  const [h, m] = String(hm).split(':').map(Number);
  return h * 60 + m;
}
export function minToHm(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }

/** Data locale in formato AAAA-MM-GG. */
export function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function slotsOfDay(semester, weekday) {
  return semester.timetable.filter(s => s.day === weekday).sort((a, b) => hmToMin(a.start) - hmToMin(b.start));
}

function atMinute(date, min) { const d = new Date(date); d.setHours(Math.floor(min / 60), min % 60, 0, 0); return d; }

/**
 * Situazione all'istante `date`:
 *  - kind 'lesson': dentro una fascia (slot, subject, transcribe, endsAt)
 *  - kind 'break': tra due fasce dello stesso giorno (nextSlot, endsAt = inizio della prossima)
 *  - kind 'before': prima della prima fascia del giorno (nextSlot)
 *  - kind 'outside': dopo l'ultima fascia o in un giorno senza lezioni
 */
export function resolveAt(semester, date) {
  const slots = slotsOfDay(semester, date.getDay());
  const m = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const subj = id => semester.subjects.find(s => s.id === id) || null;
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k], a = hmToMin(s.start), b = hmToMin(s.end);
    if (m >= a && m < b) {
      const subject = subj(s.subjectId);
      return { kind: 'lesson', slot: s, subject, transcribe: !!subject?.transcribe, endsAt: atMinute(date, b), nextSlot: slots[k + 1] || null };
    }
    if (m < a) {
      return { kind: k === 0 ? 'before' : 'break', slot: null, subject: null, transcribe: false, endsAt: atMinute(date, a), nextSlot: s, nextSubject: subj(s.subjectId) };
    }
  }
  return { kind: 'outside', slot: null, subject: null, transcribe: false, endsAt: null, nextSlot: null };
}

/** Chiave che identifica una lezione (materia + data + fascia), usata per raggruppare il testo. */
export function lessonKey(subjectId, date, slot) { return `${subjectId}|${isoDate(date)}|${slot ? slot.start : 'manuale'}`; }

/** Controlli sull'orario: sovrapposizioni e fasce invertite. Restituisce messaggi leggibili. */
export function validateTimetable(semester) {
  const issues = [];
  for (const day of [0, 1, 2, 3, 4, 5, 6]) {
    const slots = slotsOfDay(semester, day);
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k];
      if (hmToMin(s.end) <= hmToMin(s.start)) issues.push(`Fascia ${s.start}-${s.end}: la fine precede l'inizio.`);
      if (k && hmToMin(s.start) < hmToMin(slots[k - 1].end)) issues.push(`Fasce sovrapposte: ${slots[k - 1].start}-${slots[k - 1].end} e ${s.start}-${s.end}.`);
      if (!semester.subjects.some(m => m.id === s.subjectId)) issues.push(`Fascia ${s.start}-${s.end} senza materia.`);
    }
  }
  return issues;
}
