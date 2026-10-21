import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Repeat, X } from 'lucide-react';

import { addDays, eventsForGuildDay, fmtTimeEst, loaCovers, loaSkipsDate, todayInGuildTz } from '../timeUtils';
import { useT, translate, fmtDay, weekdayName } from '../i18n';

// ── WHO'S OUT, NIGHT BY NIGHT ───────────────────────────────────────────────
// One row per member with an LOA touching the week, one column per guild night,
// Monday to Sunday. The month calendar counts heads per day; this shows the
// shape — a vacation is one bar, a standing Tuesday reads as a habit, and "out
// after 8" is visibly not the same as "out all night".
//
// Bars come in four kinds, the legend's four:
//   full     — the whole night (a range, or an LOA with no time and no event)
//   partial  — part of the night (a time window)
//   single   — one scheduled event only
//   lifted   — a weekly LOA with this date taken out of the series: shown, but
//              not counted, because the member said they'll be there
//
// Everything is computed from /api/loa/all, which the page already holds.

const DAY_SHORT = (dow) => weekdayName(dow, 'short');
const DAY_NAME = (dow) => weekdayName(dow);
const LANE_PX = 30;

const dowOf = (d) => new Date(`${d}T12:00:00`).getDay();
const shortDate = (d) => fmtDay(d);

const hoursOf = (e) => {
  if (!e.start_time) return null;
  return e.end_time ? `${fmtTimeEst(e.start_time)} – ${fmtTimeEst(e.end_time)}` : translate('cal.loaFrom', { time: fmtTimeEst(e.start_time) });
};

// What kind of bar one entry makes on one night, and its label.
function barFor(e, date, scheduleById) {
  const ev = e.event_schedule_id ? scheduleById[e.event_schedule_id] : null;
  const hours = hoursOf(e);
  const kind = e.event_schedule_id ? 'single' : hours ? 'partial' : 'full';
  const what = ev ? `${ev.name}${hours ? ` · ${hours}` : ''}` : (hours || translate('cal.allNight'));
  if (e.type === 'recurring') {
    const lifted = loaSkipsDate(e, date);
    return { kind: lifted ? 'lifted' : kind, label: lifted ? translate('cal.everyDay', { day: DAY_SHORT(e.day_of_week) }) : what, repeat: true };
  }
  return { kind, label: what, repeat: false };
}

// Pack a member's bars into as few lanes as possible: each bar takes the first
// lane where it doesn't overlap. Most members need one.
function intoLanes(bars) {
  const laneEnds = [];
  return [...bars].sort((a, b) => a.from - b.from || b.to - a.to).map((b) => {
    let lane = laneEnds.findIndex((end) => end < b.from);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(-1); }
    laneEnds[lane] = b.to;
    return { ...b, lane };
  });
}

const BAR_STYLE = {
  full: 'bg-brass/35 border border-brass text-bone',
  partial: 'border border-brass/70 text-bone bar-partial',
  single: 'border border-dashed border-brassbright text-brassbright',
  lifted: 'border border-line text-ash line-through',
};

export default function LoaWeekGrid({ entries, schedule }) {
  const { t, lang } = useT();
  const today = todayInGuildTz();
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState(null); // { discordId, index }

  const days = useMemo(() => {
    const monday = addDays(today, -((dowOf(today) + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [today, offset]);

  const scheduleById = useMemo(() => Object.fromEntries((schedule || []).map((s) => [s.id, s])), [schedule]);

  const { rows, counts } = useMemo(() => {
    const first = days[0];
    const last = days[6];
    const byMember = new Map();
    const add = (e, bar) => {
      if (!byMember.has(e.discord_id)) byMember.set(e.discord_id, { discordId: e.discord_id, name: e.display_name || t('cal.member'), bars: [] });
      byMember.get(e.discord_id).bars.push({ ...bar, entry: e });
    };

    (entries || []).forEach((e) => {
      if (e.type === 'range') {
        if (!e.start_date || !e.end_date || e.end_date < first || e.start_date > last) return;
        const from = days.findIndex((d) => d >= e.start_date);
        const to = 6 - [...days].reverse().findIndex((d) => d <= e.end_date);
        // Arrows say the bar carries on past the week's edge.
        const label = `${e.start_date < first ? '‹ ' : ''}${shortDate(e.start_date)} – ${shortDate(e.end_date)}${e.end_date > last ? ' ›' : ''}`;
        add(e, { from, to, kind: 'full', label, repeat: false });
      } else if (e.type === 'event') {
        const i = days.indexOf(e.event_date);
        if (i !== -1) add(e, { from: i, to: i, ...barFor(e, e.event_date, scheduleById) });
      } else if (e.type === 'recurring') {
        days.forEach((d, i) => {
          if (dowOf(d) === e.day_of_week) add(e, { from: i, to: i, ...barFor(e, d, scheduleById) });
        });
      }
    });

    // Heads per night, not rows: a range and a weekly LOA on the same night are
    // one person out. A lifted night doesn't count — they said they'll be there.
    const out = days.map(() => new Set());
    byMember.forEach((m) => m.bars.forEach((b) => {
      if (b.kind === 'lifted') return;
      for (let i = b.from; i <= b.to; i++) out[i].add(m.discordId);
    }));

    return {
      rows: [...byMember.values()]
        .map((m) => ({ ...m, bars: intoLanes(m.bars) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      counts: out.map((s) => s.size),
    };
    // `lang` because the bar labels are built here, in the site language.
  }, [entries, days, scheduleById, lang]);

  // The picked cell: the member, the night, every bar of theirs covering it,
  // and — the part a dot can't show — which of that night's scheduled events
  // they'll miss and which they can still make.
  const detail = useMemo(() => {
    if (!picked) return null;
    const row = rows.find((r) => r.discordId === picked.discordId);
    const date = days[picked.index];
    if (!row || !date) return null;
    const bars = row.bars.filter((b) => b.from <= picked.index && b.to >= picked.index);
    if (!bars.length) return null;
    const dow = dowOf(date);
    const live = bars.filter((b) => b.kind !== 'lifted').map((b) => b.entry);
    const events = eventsForGuildDay(schedule, dow, date);
    const misses = events.filter((s) => live.some((e) => loaCovers(e, { date, dow, scheduleId: s.id, eventTime: s.event_time })));
    const makes = events.filter((s) => !misses.includes(s));
    return { row, date, dow, bars, misses, makes };
  }, [picked, rows, days, schedule]);

  return (
    <div className="space-y-4">
      {/* Hatching for "part of the night". A pattern, not a second colour, so it
          still reads apart from "all night" for anyone who can't tell hues. */}
      <style>{'.bar-partial{background:repeating-linear-gradient(135deg,rgb(var(--color-brass)/.35) 0 6px,rgb(var(--color-brass)/.08) 6px 12px)}'}</style>

      <div className="flex items-center justify-between gap-4 panel rounded-lg px-4 py-3">
        <button onClick={() => { setOffset((o) => o - 1); setPicked(null); }} className="inline-flex items-center gap-1 text-sm text-brass hover:text-brassbright">
          <ChevronLeft className="w-4 h-4" /> {t('cal.previous')}
        </button>
        <div className="text-center">
          <div className="text-bone text-sm">{shortDate(days[0])} – {shortDate(days[6])}</div>
          <div className="eyebrow text-[10px] text-ash/75 mt-0.5">
            {offset === 0 ? t('cal.thisWeek') : offset > 0 ? t('cal.inWeeks', { count: offset }) : t('cal.weeksAgo', { count: -offset })}
            {' · '}{t('loagrid.membersAway', { count: rows.length })}
            {offset !== 0 && (
              <button onClick={() => { setOffset(0); setPicked(null); }} className="ml-2 text-brass hover:text-brassbright normal-case tracking-normal">{t('cal.thisWeekLink')}</button>
            )}
          </div>
        </div>
        <button onClick={() => { setOffset((o) => o + 1); setPicked(null); }} className="inline-flex items-center gap-1 text-sm text-brass hover:text-brassbright">
          {t('cal.next')} <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="panel rounded-lg py-12 text-center text-ash text-sm">{t('loagrid.nobody')}</div>
      ) : (
        <div className="panel rounded-lg overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[150px_repeat(7,minmax(0,1fr))] border-b border-line">
              <div className="px-3 py-2 eyebrow text-[10px] text-ash self-end">{t('cal.member')}</div>
              {days.map((d, i) => (
                <div key={d} className={`border-l border-line px-1 py-2 text-center ${d === today ? 'bg-brass/5' : ''}`}>
                  <div className={`text-sm ${d === today ? 'text-brass font-semibold' : d < today ? 'text-ash/60' : 'text-bone'}`}>
                    {fmtDay(d, { weekday: 'short', month: 'numeric', day: 'numeric' })}
                  </div>
                  <div className={`mt-1 inline-block rounded-full px-2 font-mono text-[11px] ${counts[i] ? 'bg-brass/15 text-brassbright' : 'text-ash/50'}`}>
                    {t('loagrid.nOut', { count: counts[i] })}
                  </div>
                </div>
              ))}
            </div>

            {rows.map((r) => {
              const lanes = Math.max(1, ...r.bars.map((b) => b.lane + 1));
              return (
                <div
                  key={r.discordId}
                  className="grid grid-cols-[150px_repeat(7,minmax(0,1fr))] border-b border-line last:border-b-0"
                  style={{ gridTemplateRows: `repeat(${lanes}, ${LANE_PX}px)`, paddingBlock: 6 }}
                >
                  <div className="px-3 flex items-center text-sm text-bone truncate" style={{ gridColumn: 1, gridRow: `1 / span ${lanes}` }}>
                    {r.name}
                  </div>
                  {days.map((d, i) => (
                    <div
                      key={d}
                      className={`border-l border-line ${d === today ? 'bg-brass/5' : ''}`}
                      style={{ gridColumn: i + 2, gridRow: `1 / span ${lanes}`, marginBlock: -6 }}
                    />
                  ))}
                  {r.bars.map((b, bi) => {
                    const on = picked?.discordId === r.discordId && picked.index >= b.from && picked.index <= b.to;
                    // A bar spanning several nights opens on tonight when it
                    // covers tonight, else on its first night.
                    const ti = days.indexOf(today);
                    const at = ti >= b.from && ti <= b.to ? ti : b.from;
                    return (
                      <button
                        key={bi}
                        onClick={() => setPicked(on ? null : { discordId: r.discordId, index: at })}
                        title={b.label}
                        className={`mx-1 my-0.5 rounded px-2 flex items-center gap-1 text-[11px] text-left overflow-hidden whitespace-nowrap hover:brightness-125 ${BAR_STYLE[b.kind]} ${on ? 'ring-2 ring-bone' : ''}`}
                        style={{ gridColumn: `${b.from + 2} / ${b.to + 3}`, gridRow: b.lane + 1 }}
                      >
                        {b.repeat && <Repeat className="w-3 h-3 shrink-0" />}
                        <span className="truncate">{b.label}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {detail && (
        <div className="panel rounded-lg px-4 py-3 text-sm flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
          <span className="text-bone font-medium">{detail.row.name}</span>
          <span className="text-ash">{DAY_NAME(detail.dow)}, {shortDate(detail.date)}</span>
          {detail.bars.map((b, i) => (
            <span key={i} className={b.kind === 'lifted' ? 'text-ash' : 'text-bone'}>
              {b.kind === 'lifted' ? t('loagrid.lifted') : b.entry.type === 'range' ? `${t('cal.allNight')} · ${b.label.replace(/[‹›]/g, '').trim()}` : b.label}
              {b.repeat && b.kind !== 'lifted' && <span className="text-ash"> · {t('cal.everyDay', { day: DAY_NAME(b.entry.day_of_week) })}</span>}
            </span>
          ))}
          {detail.misses.length > 0 && (
            <span className="text-ash">{t('loagrid.misses')} <span className="text-brassbright">{detail.misses.map((s) => `${s.name}${s.event_time ? ` ${fmtTimeEst(s.event_time)}` : ''}`).join(' · ')}</span></span>
          )}
          {detail.makes.length > 0 && detail.misses.length > 0 && (
            <span className="text-ash">{t('loagrid.canMake')} <span className="text-bone">{detail.makes.map((s) => `${s.name}${s.event_time ? ` ${fmtTimeEst(s.event_time)}` : ''}`).join(' · ')}</span></span>
          )}
          {/* Reasons only arrive for officers; /api/loa/all strips them otherwise. */}
          {detail.bars.filter((b) => b.entry.reason).map((b, i) => (
            <span key={`r${i}`} className="text-ash italic">“{b.entry.reason}”</span>
          ))}
          <button onClick={() => setPicked(null)} className="ml-auto text-ash hover:text-bone" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ash">
        <span className="inline-flex items-center gap-1.5"><span className={`w-6 h-3 rounded-sm ${BAR_STYLE.full}`} />{t('cal.allNight')}</span>
        <span className="inline-flex items-center gap-1.5"><span className={`w-6 h-3 rounded-sm ${BAR_STYLE.partial}`} />{t('loagrid.partOfNight')}</span>
        <span className="inline-flex items-center gap-1.5"><span className={`w-6 h-3 rounded-sm ${BAR_STYLE.single}`} />{t('loagrid.oneEventOnly')}</span>
        <span className="inline-flex items-center gap-1.5"><Repeat className="w-3 h-3 text-bone" />{t('loagrid.repeatsWeekly')}</span>
        <span className="inline-flex items-center gap-1.5"><span className="line-through">{t('cal.everyDay', { day: DAY_SHORT(2) })}</span>{t('loagrid.liftedLegend')}</span>
        <span className="ml-auto">{t('loagrid.clickBar')}</span>
      </div>
    </div>
  );
}
