// ==UserScript==
// @name         LIBRUS Rodzina — czysty pulpit
// @namespace    https://github.com/tunguski/librus-tampermonkey
// @version      1.0.0
// @description  Prosty, czysty pulpit dla portalu LIBRUS Rodzina: oceny i zachowanie, plan lekcji i terminarz, wiadomości oraz zadania domowe — w jednym przejrzystym widoku.
// @author       tunguski
// @match        https://portal.librus.pl/rodzina/widget*
// @match        https://portal.librus.pl/rodzina/home*
// @match        https://portal.librus.pl/rodzina/dashboard*
// @run-at       document-idle
// @connect      api.librus.pl
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

/*
 * Jak to działa (przepływ danych zweryfikowany na podstawie librus-sdk):
 *   1. portal.librus.pl/api/v3/SynergiaAccounts  (sesja cookie portalu, same-origin)
 *        -> lista dzieci, każde z własnym `accessToken`
 *   2. api.librus.pl/3.0/<zasób>  z nagłówkiem Authorization: Bearer <accessToken>
 *        -> oceny, plan lekcji, terminarz, wiadomości, zadania domowe
 *
 * Token z portalu jest "per-dziecko", więc nie trzeba przełączać aktywnego konta po stronie serwera.
 * Niektóre tokeny nie mają zakresu `messages` — wtedy panel wiadomości pokaże stosowną informację.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Konfiguracja
  // ---------------------------------------------------------------------------
  const PORTAL_API = 'https://portal.librus.pl/api/v3';
  const SYNERGIA_API = 'https://api.librus.pl/3.0';
  const STORAGE_CHILD_KEY = 'lrClean.selectedChildId';

  // ---------------------------------------------------------------------------
  // Drobne narzędzia
  // ---------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function')
        node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(
        child.nodeType ? child : document.createTextNode(String(child)),
      );
    }
    return node;
  };

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const mondayOf = (d) => {
    const x = new Date(d);
    const day = (x.getDay() + 6) % 7; // 0 = poniedziałek
    x.setDate(x.getDate() - day);
    return x;
  };
  const DOW_PL = [
    'niedziela',
    'poniedziałek',
    'wtorek',
    'środa',
    'czwartek',
    'piątek',
    'sobota',
  ];
  const MON_PL = [
    'sty',
    'lut',
    'mar',
    'kwi',
    'maj',
    'cze',
    'lip',
    'sie',
    'wrz',
    'paź',
    'lis',
    'gru',
  ];
  const parseYmd = (s) => {
    if (!s) return null;
    const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  };
  const fmtDate = (s) => {
    const d = parseYmd(s);
    if (!d) return s || '';
    return `${d.getDate()} ${MON_PL[d.getMonth()]}`;
  };
  const fmtDateLong = (s) => {
    const d = parseYmd(s);
    if (!d) return s || '';
    return `${DOW_PL[d.getDay()]}, ${d.getDate()} ${MON_PL[d.getMonth()]}`;
  };
  // akceptuje timestamp (epoch s/ms) albo "YYYY-MM-DD HH:MM[:SS]" → data + godzina (do minut)
  const toDate = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d{9,}$/.test(String(v).trim())) {
      let n = Number(v);
      if (n < 1e12) n *= 1000; // sekundy → milisekundy
      const d = new Date(n);
      return isNaN(d) ? null : d;
    }
    const m = String(v).match(
      /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/,
    );
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const d = new Date(v);
    return isNaN(d) ? null : d;
  };
  const fmtDateTime = (v) => {
    const d = toDate(v);
    if (!d) return v ? String(v) : '';
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? time : `${d.getDate()} ${MON_PL[d.getMonth()]}, ${time}`;
  };
  // pierwsza zdefiniowana wartość spośród podanych kluczy obiektu
  const pick = (obj, ...keys) => {
    if (!obj) return undefined;
    for (const k of keys)
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '')
        return obj[k];
    return undefined;
  };
  // LIBRUS bywa zwraca literalne sekwencje \uXXXX / \n w treści — rozkoduj je
  const unescapeText = (s) =>
    String(s)
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/\\r\\n|\\n|\\r/g, '\n')
      .replace(/\\t/g, ' ')
      .replace(/\\\//g, '/');
  const stripHtml = (s) => {
    if (!s) return '';
    const t = document.createElement('div');
    t.innerHTML = unescapeText(s);
    return (t.textContent || '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  };
  // jak stripHtml, ale zachowuje podział na wiersze (do szczegółów)
  const stripHtmlMultiline = (s) => {
    if (!s) return '';
    const t = document.createElement('div');
    t.innerHTML = unescapeText(s).replace(/<br\s*\/?>(?=)/gi, '\n');
    return (t.textContent || '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const escapeId = (ref) => (ref && typeof ref === 'object' ? ref.Id : ref);
  // Znacznik szablonu CSS — w runtime zwraca zwykły tekst, ale dzięki nazwie
  // `css` Prettier/IDE formatują i kolorują blok stylów poniżej.
  const css = (strings, ...values) =>
    strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');

  // ---------------------------------------------------------------------------
  // Warstwa sieci
  // ---------------------------------------------------------------------------
  function portalFetch(path) {
    return fetch(PORTAL_API + path, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    }).then((r) => {
      if (!r.ok) throw new Error(`Portal ${path} → HTTP ${r.status}`);
      return r.json();
    });
  }

  function gmGet(url, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 20000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('Nieprawidłowa odpowiedź JSON'));
            }
          } else {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            reject(err);
          }
        },
        onerror: () => reject(new Error('Błąd sieci')),
        ontimeout: () => reject(new Error('Przekroczono limit czasu')),
      });
    });
  }

  function synergia(token, path, query) {
    const url = new URL(SYNERGIA_API + path);
    if (query)
      for (const [k, v] of Object.entries(query))
        if (v != null) url.searchParams.set(k, v);
    return gmGet(url.toString(), token);
  }

  // ---------------------------------------------------------------------------
  // Oceny — kolory i obliczenia
  // ---------------------------------------------------------------------------
  const gradeBase = (g) => {
    const m = String(g).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  function gradeColor(g) {
    const b = gradeBase(g);
    const palette = {
      1: '#e5484d',
      2: '#e2643a',
      3: '#d8a200',
      4: '#3fae6b',
      5: '#1f9d57',
      6: '#0e7a8b',
    };
    return palette[b] || '#6b7280';
  }
  function average(grades) {
    const nums = grades
      .map((g) => gradeBase(pick(g, 'Grade')))
      .filter((n) => n != null && n >= 1 && n <= 6);
    if (!nums.length) return null;
    return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
  }

  // ---------------------------------------------------------------------------
  // Renderowanie paneli
  // ---------------------------------------------------------------------------
  function panel(title, subtitle) {
    const body = el('div', { class: 'lr-panel-body' });
    const card = el(
      'section',
      { class: 'lr-panel' },
      el(
        'header',
        { class: 'lr-panel-head' },
        el('h2', { text: title }),
        subtitle ? el('span', { class: 'lr-panel-sub', text: subtitle }) : null,
      ),
      body,
    );
    return { card, body };
  }

  function loadingNote() {
    return el(
      'div',
      { class: 'lr-note' },
      el('span', { class: 'lr-spinner' }),
      'Ładowanie…',
    );
  }
  function emptyNote(text) {
    return el('div', {
      class: 'lr-note lr-muted',
      text: text || 'Brak danych.',
    });
  }
  function errorNote(text) {
    return el('div', { class: 'lr-note lr-error', text });
  }

  // --- Panel 1: Oceny i zachowanie ---
  async function renderGrades(body, token) {
    body.replaceChildren(loadingNote());
    try {
      const [subjectsRes, gradesRes, behaviourRes] = await Promise.all([
        synergia(token, '/Subjects').catch(() => null),
        synergia(token, '/Grades'),
        synergia(token, '/BehaviourGrades').catch(() => null),
      ]);

      const subjectList = (subjectsRes && subjectsRes.Subjects) || [];
      const subjects = {};
      for (const s of subjectList)
        subjects[s.Id] = pick(s, 'Name') || `Przedmiot ${s.Id}`;
      const subjName = (ref) =>
        subjects[escapeId(ref)] || (ref && ref.Name) || '—';

      const grades = (gradesRes && gradesRes.Grades) || [];
      body.replaceChildren();

      // Zachowanie
      const beh = (behaviourRes && behaviourRes.Grades) || [];
      if (beh.length) {
        const latest = beh[beh.length - 1];
        const val = pick(latest, 'Grade', 'Suggestion', 'Name') || '—';
        body.append(
          el(
            'div',
            { class: 'lr-behaviour' },
            el('span', { class: 'lr-behaviour-label', text: 'Zachowanie' }),
            el('span', { class: 'lr-behaviour-val', text: String(val) }),
          ),
        );
      }

      // grupowanie ocen po ID przedmiotu
      const bySubject = new Map();
      for (const g of grades) {
        const key = String(escapeId(pick(g, 'Subject')) ?? '_');
        if (!bySubject.has(key)) bySubject.set(key, []);
        bySubject.get(key).push(g);
      }

      // kolejność: wszystkie przedmioty z /Subjects + ewentualne przedmioty,
      // które wystąpiły tylko w ocenach (gdyby /Subjects było niepełne)
      const rows = [];
      const seen = new Set();
      for (const s of subjectList) {
        rows.push({
          name: subjects[s.Id],
          gs: bySubject.get(String(s.Id)) || [],
        });
        seen.add(String(s.Id));
      }
      for (const [key, gs] of bySubject) {
        if (key !== '_' && !seen.has(key))
          rows.push({ name: subjName(gs[0].Subject), gs });
      }
      // jeśli /Subjects zawiodło — pokaż przynajmniej przedmioty z ocen
      if (!rows.length && bySubject.size) {
        for (const [, gs] of bySubject)
          rows.push({ name: subjName(gs[0].Subject), gs });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name, 'pl'));

      if (!rows.length) {
        body.append(emptyNote('Brak ocen.'));
        return;
      }

      const list = el('div', { class: 'lr-grades' });
      for (const row of rows) {
        const sorted = row.gs
          .slice()
          .sort((a, b) =>
            String(pick(a, 'Date')).localeCompare(String(pick(b, 'Date'))),
          );
        const chips = el('div', { class: 'lr-chips' });
        for (const g of sorted) {
          const val = pick(g, 'Grade');
          chips.append(
            el('span', {
              class: 'lr-chip',
              style: `background:${gradeColor(val)}`,
              title: `${fmtDate(pick(g, 'Date'))}${pick(g, 'IsSemester') ? ' • semestralna' : ''}`,
              text: String(val),
            }),
          );
        }
        if (!sorted.length)
          chips.append(el('span', { class: 'lr-chip-empty', text: '—' }));
        const avg = average(sorted);
        list.append(
          el(
            'div',
            {
              class: `lr-grade-row${sorted.length ? '' : ' lr-grade-row-empty'}`,
            },
            el(
              'div',
              { class: 'lr-grade-subject' },
              el('span', { class: 'lr-grade-name', text: row.name }),
              avg
                ? el('span', { class: 'lr-grade-avg', text: `śr. ${avg}` })
                : null,
            ),
            chips,
          ),
        );
      }
      body.append(list);
    } catch (e) {
      body.replaceChildren(
        errorNote(`Nie udało się pobrać ocen (${e.message}).`),
      );
    }
  }

  // --- Panel 2: Plan lekcji i terminarz ---
  function lessonRow(l) {
    const subj = pick(l, 'Subject');
    const subjName = (subj && (subj.Name || subj.Short)) || '—';
    const teacher = pick(l, 'Teacher');
    const teacherName = teacher
      ? [pick(teacher, 'FirstName'), pick(teacher, 'LastName')]
          .filter(Boolean)
          .join(' ')
      : '';
    const room = pick(l, 'Classroom');
    const roomName = room ? pick(room, 'Name', 'Symbol') || '' : '';
    const canceled = !!pick(l, 'IsCanceled');
    const subst = !!pick(l, 'IsSubstitutionClass');
    const time = [pick(l, 'HourFrom'), pick(l, 'HourTo')]
      .filter(Boolean)
      .join('–');
    return el(
      'div',
      { class: `lr-lesson${canceled ? ' lr-lesson-cancel' : ''}` },
      el('span', {
        class: 'lr-lesson-no',
        text: String(pick(l, 'LessonNo') ?? ''),
      }),
      el('span', { class: 'lr-lesson-time', text: time }),
      el(
        'span',
        { class: 'lr-lesson-subj', text: subjName },
        subst
          ? el('span', { class: 'lr-tag lr-tag-subst', text: 'zastępstwo' })
          : null,
        canceled
          ? el('span', { class: 'lr-tag lr-tag-cancel', text: 'odwołane' })
          : null,
      ),
      el('span', {
        class: 'lr-lesson-meta',
        text: [roomName && `s. ${roomName}`, teacherName]
          .filter(Boolean)
          .join(' • '),
      }),
    );
  }
  function daySlots(tt, dateStr) {
    return (tt[dateStr] || [])
      .flat()
      .filter(Boolean)
      .sort(
        (a, b) => (+pick(a, 'LessonNo') || 0) - (+pick(b, 'LessonNo') || 0),
      );
  }

  function renderTimetable(body, token) {
    const state = { anchor: new Date(), mode: 'day' };
    const weekCache = new Map();

    const prevBtn = el('button', { class: 'lr-nav', title: 'Poprzedni' }, '‹');
    const nextBtn = el('button', { class: 'lr-nav', title: 'Następny' }, '›');
    const label = el('span', { class: 'lr-tt-label' });
    const modeBtn = el('button', {
      class: 'lr-btn lr-btn-sm',
      title: 'Przełącz dzień/tydzień',
    });
    const controls = el(
      'div',
      { class: 'lr-tt-controls' },
      el('div', { class: 'lr-tt-nav' }, prevBtn, label, nextBtn),
      modeBtn,
    );
    const planContent = el('div', { class: 'lr-tt-content' });
    const termWrap = el('div', { class: 'lr-subsection lr-term' });
    body.replaceChildren(controls, planContent, termWrap);

    const getWeek = async (weekStart) => {
      if (!weekCache.has(weekStart)) {
        const res = await synergia(token, '/Timetables', { weekStart }).catch(
          () => ({ Timetable: {} }),
        );
        weekCache.set(weekStart, (res && res.Timetable) || {});
      }
      return weekCache.get(weekStart);
    };

    async function draw() {
      modeBtn.textContent = state.mode === 'day' ? 'Tydzień' : 'Dzień';
      planContent.replaceChildren(loadingNote());
      const weekStartDate = mondayOf(state.anchor);
      const tt = await getWeek(ymd(weekStartDate));

      if (state.mode === 'day') {
        label.textContent = fmtDateLong(ymd(state.anchor));
        const slots = daySlots(tt, ymd(state.anchor));
        if (!slots.length) {
          planContent.replaceChildren(emptyNote('Brak lekcji tego dnia.'));
          return;
        }
        const plan = el('div', { class: 'lr-lessons' });
        slots.forEach((l) => plan.append(lessonRow(l)));
        planContent.replaceChildren(plan);
      } else {
        const end = new Date(weekStartDate);
        end.setDate(end.getDate() + 4);
        label.textContent = `${fmtDate(ymd(weekStartDate))} – ${fmtDate(ymd(end))}`;
        const wrap = el('div', { class: 'lr-week' });
        let any = false;
        for (let i = 0; i < 5; i++) {
          const d = new Date(weekStartDate);
          d.setDate(d.getDate() + i);
          const ds = ymd(d);
          const slots = daySlots(tt, ds);
          if (!slots.length) continue;
          any = true;
          const dayBox = el(
            'div',
            {
              class: `lr-week-day${ds === todayStr() ? ' lr-week-today' : ''}`,
            },
            el('div', {
              class: 'lr-week-dayhead',
              text: `${DOW_PL[d.getDay()]} ${d.getDate()} ${MON_PL[d.getMonth()]}`,
            }),
          );
          const plan = el('div', { class: 'lr-lessons' });
          slots.forEach((l) => plan.append(lessonRow(l)));
          dayBox.append(plan);
          wrap.append(dayBox);
        }
        planContent.replaceChildren(
          any ? wrap : emptyNote('Brak lekcji w tym tygodniu.'),
        );
      }
    }

    const step = () => (state.mode === 'day' ? 1 : 7);
    prevBtn.addEventListener('click', () => {
      state.anchor.setDate(state.anchor.getDate() - step());
      draw();
    });
    nextBtn.addEventListener('click', () => {
      state.anchor.setDate(state.anchor.getDate() + step());
      draw();
    });
    modeBtn.addEventListener('click', () => {
      state.mode = state.mode === 'day' ? 'week' : 'day';
      draw();
    });
    draw();

    // Terminarz — nadchodzące wydarzenia z HomeWorks (niezależne od nawigacji planu)
    (async () => {
      termWrap.replaceChildren(
        el('h3', { class: 'lr-subhead' }, el('span', { text: 'Terminarz' })),
        loadingNote(),
      );
      const today = todayStr();
      const hwRes = await synergia(token, '/HomeWorks').catch(() => null);
      const events = ((hwRes && hwRes.HomeWorks) || [])
        .filter((h) => String(pick(h, 'Date')) >= today)
        .sort((a, b) =>
          String(pick(a, 'Date')).localeCompare(String(pick(b, 'Date'))),
        )
        .slice(0, 8);
      termWrap.replaceChildren(
        el('h3', { class: 'lr-subhead' }, el('span', { text: 'Terminarz' })),
      );
      if (!events.length) {
        termWrap.append(emptyNote('Brak nadchodzących wydarzeń.'));
        return;
      }
      const evList = el('div', { class: 'lr-events' });
      for (const ev of events) {
        const cat = pick(ev, 'Category');
        const catName = cat && cat.Name ? cat.Name : '';
        const subj = pick(ev, 'Subject');
        const subjName =
          subj && (subj.Name || subj.Short) ? subj.Name || subj.Short : '';
        evList.append(
          el(
            'div',
            { class: 'lr-event' },
            el('span', {
              class: 'lr-event-date',
              text: fmtDate(pick(ev, 'Date')),
            }),
            el(
              'div',
              { class: 'lr-event-body' },
              el('span', {
                class: 'lr-event-title',
                text:
                  [catName, subjName].filter(Boolean).join(' • ') ||
                  'Wydarzenie',
              }),
              el('span', {
                class: 'lr-event-desc',
                text: stripHtml(pick(ev, 'Content')),
              }),
            ),
          ),
        );
      }
      termWrap.append(evList);
    })();
  }

  // --- Panel 3: Wiadomości ---
  async function renderMessages(body, token, child) {
    body.replaceChildren(loadingNote());
    const hasScope =
      !child.scopes ||
      (Array.isArray(child.scopes) &&
        child.scopes.some((s) => /message/i.test(s)));
    try {
      const res = await synergia(token, '/Messages', {
        limit: 20,
        getAllTypes: 1,
        alternativeBody: 1,
      });
      const msgs = (res && res.Messages) || [];
      body.replaceChildren();
      if (!msgs.length) {
        body.append(emptyNote('Brak wiadomości.'));
        return;
      }
      const ts = (m) => {
        const d = toDate(pick(m, 'SendDate', 'Date'));
        return d ? d.getTime() : 0;
      };
      msgs.sort((a, b) => ts(b) - ts(a));
      const list = el('div', { class: 'lr-messages' });
      for (const m of msgs.slice(0, 15)) {
        const sender = pick(m, 'Sender');
        const senderName = sender
          ? pick(sender, 'Name') ||
            [pick(sender, 'FirstName'), pick(sender, 'LastName')]
              .filter(Boolean)
              .join(' ') ||
            'Nadawca'
          : pick(m, 'SenderName') || 'Nadawca';
        const topic = pick(m, 'Topic', 'Subject', 'Title') || '(bez tematu)';
        const unread =
          pick(m, 'IsRead') === false ||
          pick(m, 'IsRead') === 0 ||
          (pick(m, 'ReadDate') == null && pick(m, 'Read') == null);

        const item = el('div', {
          class: `lr-message${unread ? ' lr-unread' : ''}`,
        });
        const head = el(
          'button',
          { type: 'button', class: 'lr-message-head' },
          el(
            'div',
            { class: 'lr-message-top' },
            el('span', {
              class: 'lr-message-sender',
              text: stripHtml(senderName),
            }),
            el('span', {
              class: 'lr-message-date',
              text: fmtDateTime(pick(m, 'SendDate', 'Date')),
            }),
          ),
          el(
            'div',
            { class: 'lr-message-topic-row' },
            el('span', { class: 'lr-message-topic', text: stripHtml(topic) }),
            el('span', { class: 'lr-msg-chevron', text: '▸' }),
          ),
        );
        const details = el('div', { class: 'lr-msg-details' });

        let loaded = false;
        head.addEventListener('click', async () => {
          item.classList.toggle('lr-open');
          if (loaded || !item.classList.contains('lr-open')) return;
          loaded = true;
          const inline = stripHtmlMultiline(
            pick(m, 'Body', 'Content', 'Message', 'Text') || '',
          );
          if (inline) {
            details.append(el('p', { class: 'lr-msg-body', text: inline }));
            return;
          }
          details.append(loadingNote());
          try {
            const full = await synergia(
              token,
              `/Messages/${encodeURIComponent(escapeId(pick(m, 'Id')))}`,
            );
            const fm = (full && full.Message) || {};
            const text = stripHtmlMultiline(
              pick(fm, 'Body', 'Content', 'Message', 'Text') || '',
            );
            details.replaceChildren(
              text
                ? el('p', { class: 'lr-msg-body', text })
                : emptyNote('Brak treści.'),
            );
          } catch (err) {
            details.replaceChildren(
              errorNote('Nie udało się pobrać treści wiadomości.'),
            );
          }
        });

        item.append(head, details);
        list.append(item);
      }
      body.append(list);
    } catch (e) {
      body.replaceChildren();
      if (e.status === 403 || e.status === 401 || !hasScope) {
        body.append(
          emptyNote(
            'Wiadomości nie są dostępne dla tego konta (token bez uprawnień „messages”). Otwórz wiadomości bezpośrednio w Synergii.',
          ),
        );
      } else {
        body.append(
          errorNote(`Nie udało się pobrać wiadomości (${e.message}).`),
        );
      }
    }
  }

  // --- Panel 4: Zadania domowe ---
  async function renderHomework(body, token) {
    body.replaceChildren(loadingNote());
    try {
      const today = todayStr();
      // nowszy moduł „zadania domowe"; w razie braku — terminarz (HomeWorks)
      let items = [];
      let usedAssignments = false;
      try {
        const res = await synergia(token, '/HomeWorkAssignments');
        items = (res && res.HomeWorkAssignments) || [];
        usedAssignments = true;
      } catch (_) {
        const res = await synergia(token, '/HomeWorks').catch(() => null);
        items = (res && res.HomeWorks) || [];
      }

      body.replaceChildren();
      if (!items.length) {
        body.append(emptyNote('Brak zadań domowych.'));
        return;
      }

      const dateOf = (it) => pick(it, 'DueDate', 'Date', 'AddDate');
      const upcoming = items
        .filter((it) => String(dateOf(it) || '') >= today)
        .sort((a, b) => String(dateOf(a)).localeCompare(String(dateOf(b))));
      const list = (
        upcoming.length
          ? upcoming
          : items
              .slice()
              .sort((a, b) =>
                String(dateOf(b)).localeCompare(String(dateOf(a))),
              )
      ).slice(0, 12);

      const wrap = el('div', { class: 'lr-homework' });
      for (const it of list) {
        const subj = pick(it, 'Subject');
        const subjName =
          subj && typeof subj === 'object'
            ? subj.Name || subj.Short || ''
            : subj || '';
        const fullText = stripHtmlMultiline(
          pick(it, 'Content', 'Description', 'Text', 'Topic', 'Title') || '',
        );
        const title = stripHtml(
          pick(it, 'Topic', 'Title', 'Content', 'Description') || 'Zadanie',
        );
        const done = pick(it, 'IsDone', 'Done', 'Completed') === true;

        // metadane do szczegółów
        const created = pick(it, 'CreatedBy', 'AddedBy', 'Teacher');
        const createdName =
          created && typeof created === 'object'
            ? [pick(created, 'FirstName'), pick(created, 'LastName')]
                .filter(Boolean)
                .join(' ') || pick(created, 'Name')
            : created;
        const cat = pick(it, 'Category');
        const catName =
          cat && typeof cat === 'object' ? pick(cat, 'Name') : cat;
        const metaRows = [
          ['Termin', fmtDateLong(pick(it, 'DueDate', 'Date'))],
          ['Dodano', fmtDate(pick(it, 'AddDate'))],
          ['Przedmiot', subjName],
          ['Kategoria', catName],
          ['Nauczyciel', createdName],
          ['Nr lekcji', pick(it, 'LessonNo')],
        ].filter(([, v]) => v != null && v !== '');

        const details = el('div', { class: 'lr-hw-details' });
        if (fullText)
          details.append(el('p', { class: 'lr-hw-content', text: fullText }));
        if (metaRows.length) {
          const dl = el('dl', { class: 'lr-hw-meta' });
          for (const [k, v] of metaRows)
            dl.append(el('dt', { text: k }), el('dd', { text: String(v) }));
          details.append(dl);
        }
        if (!details.childNodes.length)
          details.append(
            el('p', {
              class: 'lr-hw-content lr-muted',
              text: 'Brak dodatkowych szczegółów.',
            }),
          );

        const item = el('div', { class: `lr-hw${done ? ' lr-hw-done' : ''}` });
        const head = el(
          'button',
          { type: 'button', class: 'lr-hw-head' },
          el('span', { class: 'lr-hw-date', text: fmtDate(dateOf(it)) }),
          el(
            'div',
            { class: 'lr-hw-body' },
            subjName
              ? el('span', { class: 'lr-hw-subj', text: subjName })
              : null,
            el('span', { class: 'lr-hw-title', text: title }),
          ),
          el('span', { class: 'lr-hw-chevron', text: '▸' }),
        );
        head.addEventListener('click', () => item.classList.toggle('lr-open'));
        item.append(head, details);
        wrap.append(item);
      }
      const wrapEl = el(
        'div',
        {},
        usedAssignments
          ? null
          : el('div', {
              class: 'lr-note lr-muted lr-hint',
              text: 'Pokazuję wpisy z terminarza (moduł zadań niedostępny dla tokenu).',
            }),
        wrap,
      );
      body.append(wrapEl);
    } catch (e) {
      body.replaceChildren(
        errorNote(`Nie udało się pobrać zadań (${e.message}).`),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Szkielet UI
  // ---------------------------------------------------------------------------
  function buildShell(accounts) {
    document.documentElement.classList.add('lr-clean-on');
    const root = el('div', { id: 'lr-clean-root' });

    // pasek górny
    const childSel = el('select', { class: 'lr-child-select' });
    for (const a of accounts) {
      childSel.append(
        el('option', { value: a.id, text: a.studentName || a.login }),
      );
    }
    const stored = sessionStorage.getItem(STORAGE_CHILD_KEY);
    if (stored && accounts.some((a) => String(a.id) === stored))
      childSel.value = stored;

    const refreshBtn = el(
      'button',
      { class: 'lr-btn', title: 'Odśwież' },
      '↻ Odśwież',
    );
    const originalBtn = el(
      'button',
      {
        class: 'lr-btn lr-btn-ghost',
        title: 'Pokaż oryginalny widok LIBRUS (przeładuj stronę, aby wrócić)',
      },
      'Widok LIBRUS',
    );

    const bar = el(
      'header',
      { class: 'lr-topbar' },
      el(
        'div',
        { class: 'lr-brand' },
        el('span', { class: 'lr-logo', text: '◆' }),
        el('span', { text: 'LIBRUS — pulpit' }),
      ),
      el(
        'div',
        { class: 'lr-topbar-right' },
        accounts.length > 1
          ? childSel
          : el('span', {
              class: 'lr-child-single',
              text: accounts[0].studentName || accounts[0].login,
            }),
        originalBtn,
        refreshBtn,
      ),
    );

    const grid = el('main', { class: 'lr-grid' });
    const panels = {
      grades: panel('Oceny i zachowanie'),
      timetable: panel('Plan lekcji i terminarz'),
      messages: panel('Wiadomości'),
      homework: panel('Zadania domowe'),
    };
    grid.append(
      panels.grades.card,
      panels.timetable.card,
      panels.messages.card,
      panels.homework.card,
    );

    root.append(
      bar,
      grid,
      el(
        'footer',
        { class: 'lr-footer' },
        el('span', {
          text: 'Nieoficjalny czysty widok • dane: api.librus.pl/3.0',
        }),
      ),
    );

    document.body.append(root);

    const selectedChild = () =>
      accounts.find((a) => String(a.id) === String(childSel.value)) ||
      accounts[0];

    async function load() {
      const child = selectedChild();
      sessionStorage.setItem(STORAGE_CHILD_KEY, String(child.id));
      const t = child.accessToken;
      await Promise.allSettled([
        renderGrades(panels.grades.body, t),
        renderTimetable(panels.timetable.body, t),
        renderMessages(panels.messages.body, t, child),
        renderHomework(panels.homework.body, t),
      ]);
    }

    childSel.addEventListener('change', load);
    refreshBtn.addEventListener('click', load);
    load();

    // utrzymaj nasz widok, gdyby SPA Librusa próbował go usunąć / nadpisać
    const observer = new MutationObserver(() => {
      if (!document.getElementById('lr-clean-root')) document.body.append(root);
    });
    observer.observe(document.body, { childList: true });

    // przełącz na oryginalny interfejs LIBRUS; powrót = przeładowanie strony
    originalBtn.addEventListener('click', () => {
      observer.disconnect();
      root.remove();
      document.documentElement.classList.remove('lr-clean-on');
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  async function boot() {
    if (document.getElementById('lr-clean-root')) return;
    injectStyles();

    const root = el(
      'div',
      { id: 'lr-clean-root' },
      el('div', { class: 'lr-boot' }, loadingNote()),
    );
    document.documentElement.classList.add('lr-clean-on');
    document.body.append(root);

    try {
      const data = await portalFetch('/SynergiaAccounts');
      const accounts = ((data && data.accounts) || []).filter(
        (a) => a.accessToken,
      );
      root.remove();
      if (!accounts.length) {
        const empty = el(
          'div',
          { id: 'lr-clean-root' },
          el(
            'div',
            { class: 'lr-boot' },
            errorNote(
              'Nie znaleziono powiązanych kont Synergia. Zaloguj się do portalu LIBRUS Rodzina i odśwież stronę.',
            ),
          ),
        );
        document.body.append(empty);
        return;
      }
      buildShell(accounts);
    } catch (e) {
      root.replaceChildren(
        el(
          'div',
          { class: 'lr-boot' },
          errorNote(
            `Nie udało się połączyć z portalem LIBRUS (${e.message}). Upewnij się, że jesteś zalogowany.`,
          ),
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Style
  // ---------------------------------------------------------------------------
  function injectStyles() {
    const sheet = css`
      :root {
        --lr-bg: #f4f6f9;
        --lr-card: #ffffff;
        --lr-text: #1f2733;
        --lr-muted: #6b7686;
        --lr-line: #e6e9ef;
        --lr-accent: #2563eb;
        --lr-accent-soft: #eef3ff;
        --lr-shadow:
          0 1px 2px rgba(16, 24, 40, 0.04), 0 4px 16px rgba(16, 24, 40, 0.06);
        --lr-radius: 14px;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --lr-bg: #0f141b;
          --lr-card: #161c25;
          --lr-text: #e6eaf0;
          --lr-muted: #8b94a3;
          --lr-line: #232b36;
          --lr-accent: #5b8cff;
          --lr-accent-soft: #1a2436;
          --lr-shadow:
            0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
        }
      }
      /* Nie ukrywamy oryginalnego interfejsu przez display:none — to psuje inicjalizację
   Onsen UI widgetu ("Invalid state"). Zamiast tego przykrywamy go nieprzezroczystą
   nakładką na cały ekran, więc widget inicjalizuje się poprawnie w tle. */
      html.lr-clean-on,
      html.lr-clean-on body {
        background: var(--lr-bg) !important;
      }
      html.lr-clean-on body {
        overflow: hidden !important;
      }

      #lr-clean-root {
        position: fixed;
        inset: 0;
        overflow-y: auto;
        z-index: 2147483000;
        margin: 0;
        background: var(--lr-bg);
        font-family:
          ui-sans-serif,
          system-ui,
          -apple-system,
          'Segoe UI',
          Roboto,
          'Helvetica Neue',
          Arial,
          sans-serif;
        color: var(--lr-text);
        -webkit-font-smoothing: antialiased;
        line-height: 1.45;
      }
      #lr-clean-root *,
      #lr-clean-root *::before,
      #lr-clean-root *::after {
        box-sizing: border-box;
      }

      .lr-topbar {
        position: sticky;
        top: 0;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 24px;
        background: color-mix(in srgb, var(--lr-card) 86%, transparent);
        backdrop-filter: saturate(1.4) blur(8px);
        border-bottom: 1px solid var(--lr-line);
      }
      .lr-brand {
        display: flex;
        align-items: center;
        gap: 10px;
        font-weight: 650;
        letter-spacing: 0.2px;
      }
      .lr-logo {
        color: var(--lr-accent);
        font-size: 18px;
      }
      .lr-topbar-right {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .lr-child-single {
        font-weight: 600;
      }
      .lr-child-select,
      .lr-btn {
        font: inherit;
        color: var(--lr-text);
        background: var(--lr-card);
        border: 1px solid var(--lr-line);
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        transition:
          border-color 0.15s,
          background 0.15s;
      }
      .lr-child-select:hover,
      .lr-btn:hover {
        border-color: var(--lr-accent);
      }
      .lr-btn:active {
        transform: translateY(1px);
      }
      .lr-btn-ghost {
        color: var(--lr-muted);
      }
      .lr-btn-ghost:hover {
        color: var(--lr-accent);
      }

      .lr-grid {
        display: grid;
        gap: 18px;
        padding: 22px 24px;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        max-width: 1680px;
        margin: 0 auto;
      }
      @media (max-width: 1280px) {
        .lr-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .lr-grid {
          grid-template-columns: 1fr;
          padding: 16px;
        }
      }

      .lr-panel {
        background: var(--lr-card);
        border: 1px solid var(--lr-line);
        border-radius: var(--lr-radius);
        box-shadow: var(--lr-shadow);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 220px;
      }
      .lr-panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        padding: 16px 18px 12px;
        border-bottom: 1px solid var(--lr-line);
      }
      .lr-panel-head h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 650;
        letter-spacing: 0.2px;
      }
      .lr-panel-sub {
        font-size: 12px;
        color: var(--lr-muted);
      }
      .lr-panel-body {
        padding: 14px 18px 18px;
        overflow-y: auto;
        max-height: calc(100vh - 200px);
      }

      .lr-note {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
        font-size: 13px;
        color: var(--lr-muted);
      }
      .lr-muted {
        color: var(--lr-muted);
      }
      .lr-error {
        color: #e5484d;
      }
      .lr-hint {
        font-size: 11.5px;
        margin-bottom: 8px;
      }
      .lr-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid var(--lr-line);
        border-top-color: var(--lr-accent);
        display: inline-block;
        animation: lr-spin 0.7s linear infinite;
      }
      @keyframes lr-spin {
        to {
          transform: rotate(360deg);
        }
      }

      /* Oceny */
      .lr-behaviour {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        margin-bottom: 12px;
        background: var(--lr-accent-soft);
        border-radius: 10px;
      }
      .lr-behaviour-label {
        font-size: 12px;
        color: var(--lr-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .lr-behaviour-val {
        font-weight: 700;
      }
      .lr-grades {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .lr-grade-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 9px 0;
        border-bottom: 1px solid var(--lr-line);
      }
      .lr-grade-row:last-child {
        border-bottom: 0;
      }
      .lr-grade-subject {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }
      .lr-grade-name {
        font-size: 13.5px;
        font-weight: 550;
      }
      .lr-grade-avg {
        font-size: 12px;
        color: var(--lr-muted);
        white-space: nowrap;
      }
      .lr-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      .lr-chip {
        min-width: 26px;
        height: 26px;
        padding: 0 7px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-size: 13px;
        font-weight: 650;
        border-radius: 7px;
      }
      .lr-chip-empty {
        color: var(--lr-muted);
        font-size: 13px;
      }
      .lr-grade-row-empty .lr-grade-name {
        color: var(--lr-muted);
        font-weight: 500;
      }

      /* Plan — sterowanie nawigacją */
      .lr-tt-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      .lr-tt-nav {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lr-tt-label {
        font-size: 13px;
        font-weight: 600;
        min-width: 130px;
        text-align: center;
      }
      .lr-nav {
        width: 30px;
        height: 30px;
        flex: 0 0 auto;
        padding: 0;
        font: inherit;
        font-size: 18px;
        line-height: 1;
        color: var(--lr-text);
        background: var(--lr-card);
        border: 1px solid var(--lr-line);
        border-radius: 8px;
        cursor: pointer;
      }
      .lr-nav:hover {
        border-color: var(--lr-accent);
        color: var(--lr-accent);
      }
      .lr-btn-sm {
        padding: 6px 12px;
        font-size: 12.5px;
        border-radius: 8px;
      }
      .lr-week-day {
        margin-bottom: 14px;
      }
      .lr-week-dayhead {
        font-size: 12px;
        font-weight: 650;
        color: var(--lr-muted);
        text-transform: capitalize;
        margin-bottom: 4px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--lr-line);
      }
      .lr-week-today .lr-week-dayhead {
        color: var(--lr-accent);
      }

      /* Plan i terminarz */
      .lr-subsection {
        margin-bottom: 18px;
      }
      .lr-subsection:last-child {
        margin-bottom: 0;
      }
      .lr-subhead {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin: 0 0 8px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.6px;
        color: var(--lr-muted);
      }
      .lr-subhead-meta {
        text-transform: none;
        letter-spacing: 0;
        font-weight: 500;
      }
      .lr-lessons,
      .lr-events,
      .lr-messages,
      .lr-homework {
        display: flex;
        flex-direction: column;
      }
      .lr-lesson {
        display: grid;
        grid-template-columns: 22px 50px 1fr;
        align-items: center;
        gap: 8px;
        padding: 7px 0;
        border-bottom: 1px solid var(--lr-line);
        font-size: 13px;
      }
      .lr-lesson:last-child {
        border-bottom: 0;
      }
      .lr-lesson-no {
        color: var(--lr-muted);
        font-variant-numeric: tabular-nums;
        font-size: 12px;
      }
      .lr-lesson-time {
        color: var(--lr-muted);
        font-variant-numeric: tabular-nums;
        font-size: 12px;
      }
      .lr-lesson-subj {
        font-weight: 550;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .lr-lesson-meta {
        grid-column: 3;
        color: var(--lr-muted);
        font-size: 12px;
      }
      .lr-lesson-cancel .lr-lesson-subj {
        text-decoration: line-through;
        opacity: 0.6;
      }
      .lr-tag {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 6px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
      }
      .lr-tag-subst {
        background: #fff3d6;
        color: #9a6b00;
      }
      .lr-tag-cancel {
        background: #fde2e2;
        color: #b42318;
      }
      @media (prefers-color-scheme: dark) {
        .lr-tag-subst {
          background: #3a2f12;
          color: #e7b455;
        }
        .lr-tag-cancel {
          background: #3a1b1b;
          color: #f08a82;
        }
      }

      .lr-event,
      .lr-message,
      .lr-hw {
        display: flex;
        gap: 10px;
        padding: 9px 0;
        border-bottom: 1px solid var(--lr-line);
      }
      .lr-event:last-child,
      .lr-message:last-child,
      .lr-hw:last-child {
        border-bottom: 0;
      }
      .lr-event-date,
      .lr-hw-date {
        flex: 0 0 auto;
        min-width: 46px;
        font-size: 12px;
        font-weight: 600;
        color: var(--lr-accent);
        font-variant-numeric: tabular-nums;
      }
      .lr-event-body,
      .lr-hw-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .lr-event-title,
      .lr-hw-title {
        font-size: 13.5px;
        font-weight: 550;
      }
      .lr-event-desc {
        font-size: 12.5px;
        color: var(--lr-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .lr-hw-subj {
        font-size: 11.5px;
        color: var(--lr-accent);
        font-weight: 600;
      }
      .lr-hw-done .lr-hw-title {
        text-decoration: line-through;
        color: var(--lr-muted);
      }

      /* Zadania — element rozwijany */
      .lr-hw {
        flex-direction: column;
        gap: 0;
      }
      .lr-hw-head {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        width: 100%;
        padding: 9px 0;
        background: none;
        border: 0;
        cursor: pointer;
        text-align: left;
        font: inherit;
        color: inherit;
      }
      .lr-hw-chevron {
        margin-left: auto;
        color: var(--lr-muted);
        transition: transform 0.15s;
        align-self: center;
      }
      .lr-hw.lr-open .lr-hw-chevron {
        transform: rotate(90deg);
      }
      .lr-hw-details {
        display: none;
        padding: 2px 0 12px 56px;
      }
      .lr-hw.lr-open .lr-hw-details {
        display: block;
      }
      .lr-hw-content {
        margin: 0 0 10px;
        font-size: 13px;
        white-space: pre-wrap;
        color: var(--lr-text);
      }
      .lr-hw-meta {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 12px;
        margin: 0;
        font-size: 12.5px;
      }
      .lr-hw-meta dt {
        color: var(--lr-muted);
      }
      .lr-hw-meta dd {
        margin: 0;
      }

      /* Wiadomości */
      .lr-message {
        flex-direction: column;
        gap: 0;
      }
      .lr-message-head {
        display: flex;
        flex-direction: column;
        gap: 3px;
        width: 100%;
        padding: 0;
        background: none;
        border: 0;
        cursor: pointer;
        text-align: left;
        font: inherit;
        color: inherit;
      }
      .lr-message-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }
      .lr-message-sender {
        font-size: 13px;
        font-weight: 550;
      }
      .lr-message-date {
        font-size: 12px;
        color: var(--lr-muted);
        white-space: nowrap;
      }
      .lr-message-topic-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lr-message-topic {
        font-size: 13px;
        color: var(--lr-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      .lr-msg-chevron {
        color: var(--lr-muted);
        flex: 0 0 auto;
        transition: transform 0.15s;
        font-size: 12px;
      }
      .lr-message.lr-open .lr-msg-chevron {
        transform: rotate(90deg);
      }
      .lr-message.lr-open .lr-message-topic {
        white-space: normal;
      }
      .lr-msg-details {
        display: none;
        padding: 8px 0 4px;
      }
      .lr-message.lr-open .lr-msg-details {
        display: block;
      }
      .lr-msg-body {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        color: var(--lr-text);
      }
      .lr-unread .lr-message-sender::before {
        content: '● ';
        color: var(--lr-accent);
        font-size: 10px;
        vertical-align: middle;
      }
      .lr-unread .lr-message-topic {
        color: var(--lr-text);
        font-weight: 500;
      }

      .lr-footer {
        padding: 18px 24px 28px;
        text-align: center;
        font-size: 12px;
        color: var(--lr-muted);
      }
      .lr-boot {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 60vh;
        padding: 24px;
      }
    `;
    if (typeof GM_addStyle === 'function') GM_addStyle(sheet);
    else document.head.append(el('style', { text: sheet }));
  }

  // odpal po załadowaniu
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
