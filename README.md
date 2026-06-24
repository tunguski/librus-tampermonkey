# LIBRUS Rodzina — czysty pulpit (Tampermonkey)

Userscript, który zastępuje interfejs portalu **LIBRUS Rodzina** prostym, czytelnym
pulpitem z czterema panelami:

| Panel | Źródło danych |
|-------|---------------|
| **Oceny i zachowanie** | `/Grades`, `/BehaviourGrades`, `/Subjects` |
| **Plan lekcji i terminarz** | `/Timetables`, `/HomeWorks` |
| **Wiadomości** | `/Messages` |
| **Zadania domowe** | `/HomeWorkAssignments` (fallback: `/HomeWorks`) |

Czysty, jasny/ciemny motyw (podąża za ustawieniem systemu), responsywna siatka
4 → 2 → 1 kolumny, brak zbędnych elementów.

### Interakcje

- **Oceny** — wszystkie przedmioty (klasy) ucznia, pogrupowane, z prostą średnią.
- **Plan lekcji** — przyciski `‹` / `›` (poprzedni/następny) oraz przełącznik
  **Dzień / Tydzień** w nagłówku panelu.
- **Zadania domowe** — kliknięcie nagłówka **rozwija** szczegóły (pełna treść +
  metadane: termin, przedmiot, kategoria, nauczyciel).
- **Wiadomości** — poprawne dekodowanie polskich znaków (sekwencje `\uXXXX`).
- Selektor dziecka w pasku górnym (gdy kont jest więcej niż jedno) + odświeżanie.

## Instalacja

1. Zainstaluj rozszerzenie **[Tampermonkey](https://www.tampermonkey.net/)**
   (Chrome / Edge / Firefox).
2. Otwórz plik [`librus-clean-dashboard.user.js`](./librus-clean-dashboard.user.js)
   — Tampermonkey wykryje nagłówek `// ==UserScript==` i zaproponuje instalację.
   (Albo: Dashboard → *Utwórz nowy skrypt* → wklej zawartość → zapisz.)
3. Zaloguj się na **<https://portal.librus.pl/rodzina>** swoim *Kontem LIBRUS*.
4. Wejdź na pulpit rodziny — zobaczysz nowy, czysty widok.

## Jak to działa

Przepływ uwierzytelnienia (zweryfikowany na podstawie projektu
[`andrewkoltsov/librus-sdk`](https://github.com/andrewkoltsov/librus-sdk)):

1. **`GET portal.librus.pl/api/v3/SynergiaAccounts`** — wywołanie *same-origin*,
   korzysta z Twojej istniejącej sesji (cookie) portalu. Zwraca listę powiązanych
   dzieci, a **każde** ma własny `accessToken`.
2. **`GET api.librus.pl/3.0/<zasób>`** z nagłówkiem
   `Authorization: Bearer <accessToken>` — to wywołanie jest *cross-origin*, więc
   wykonywane jest przez `GM_xmlhttpRequest` (stąd `@connect api.librus.pl`
   i uprawnienie `GM_xmlhttpRequest`).

Token z portalu jest „per-dziecko”, więc przełączanie dziecka odbywa się lokalnie
(selektor w pasku górnym) — bez zmiany stanu po stronie serwera.

Każdy panel pobiera dane **niezależnie** i degraduje się łagodnie: jeśli token
danego dziecka nie ma zakresu `messages`, panel wiadomości pokaże stosowną
informację zamiast się wywalić.

## Dostosowanie

- **Zakres stron** — domyślnie skrypt działa na `…/rodzina/widget`,
  `…/rodzina/home` i `…/rodzina/dashboard` (z pominięciem publicznych artykułów
  `/rodzina/artykuly/*`). Zmień dyrektywy `@match` w nagłówku, jeśli Twój pulpit
  jest pod innym adresem.
- **Kolory ocen** — funkcja `gradeColor()`.
- **Motyw / odstępy** — zmienne CSS w bloku `:root` (oraz wariant
  `prefers-color-scheme: dark`).
- **Liczba pozycji** — `slice(...)` w poszczególnych rendererach
  (`renderMessages`, `renderHomework`, `renderTimetable`).

## Uwagi i ograniczenia

- To **nieoficjalne** narzędzie, niezwiązane z LIBRUS-em. Korzysta z tego samego
  prywatnego API, co aplikacja mobilna; używaj wyłącznie na własnym koncie.
  Systematyczne pobieranie danych może naruszać regulamin Synergii.
- Kształt odpowiedzi API bywa luźno typowany — renderery odczytują pola
  defensywnie (`pick(...)`), ale jeśli LIBRUS zmieni format, część pól może być
  pusta. Najłatwiej zdiagnozować to w konsoli (DevTools → Network /
  `synergia(...)`).
- Wiadomości w nowszym module „Wiadomości 2.0” mają osobne API
  (`wiadomosci.librus.pl`) i własne uwierzytelnienie — ten skrypt korzysta z
  klasycznego `/Messages` z `api.librus.pl/3.0`.

## Struktura repo

```
librus-clean-dashboard.user.js   # cały userscript (UI + warstwa danych + style)
README.md
```
