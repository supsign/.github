# supsign/.github

Zentrale GitHub-Bausteine für alle supsign-Repos. Was hier liegt, gilt überall gleich und wird nur hier geändert.

- [Dependabot](#dependabot): Regeln, Ablauf, Einbindung
- [Branch-Schutz](#branch-schutz): Standard für den Default-Branch

## Dependabot

### Regeln

Ein Dependabot-PR wird automatisch gemergt, wenn die CI des Repos grün ist **und** die Policy zustimmt. Sonst bekommt er das Label `needs-manual-review` und einen Kommentar mit dem Grund.

| Update | Ergebnis |
|---|---|
| patch | automatisch |
| minor | automatisch (in Repos mit `max-update: patch` manuell) |
| major | manuell |
| GitHub Actions, jede Stufe inklusive major | automatisch: Die CI führt die Actions selbst aus, bricht ein Update, ist sie rot |
| Security-Update | dieselben Regeln wie oben |
| Lock-Diff: ein Paket, das Dependabot **nicht** angefordert hat, springt eine Major-Version oder wird **heruntergestuft** | manuell |
| Lock-Diff: transitive 0.x-Sprünge, Vorabversionen, Dev-Branches, neue oder entfernte Pakete | automatisch, steht im Protokoll |
| Repo ohne CI | kein Auto-Merge, weil es kein Gate gibt |

Der Lock-Diff vergleicht `composer.lock` und `package-lock.json` im Update-Verzeichnis zwischen dem Base-Branch und dem Test-Merge-Commit, also genau das, was der Merge in `main` ändert. Er fängt, was in keinen Metadaten steht. Zwei echte Fälle aus unseren Repos:

- Ein Composer-„Patch“-PR stufte `symfony/console` von v8 auf v7 herunter.
- Ein npm-Security-PR zog `nx` 22 → 23 mit und stufte `undici` von 8 auf 7 herunter.

`pnpm-lock.yaml` wird noch nicht gelesen. Für pnpm-Repos gelten nur die Metadaten-Regeln.

### Ablauf

```
Dependabot öffnet PR
  └─ CI des Repos läuft
       └─ Gate-Job `ci` grün?
            ├─ nein → nichts passiert, der PR bleibt rot
            └─ ja → zentraler Job `dependabot`
                 ├─ Metadaten + Lock-Diff → Policy
                 ├─ ok      → Merge über die REST-API, genau der geprüfte Commit
                 │            (bei „Branch veraltet“: `@dependabot rebase`, der nächste Lauf merged)
                 └─ nicht ok → Label + ein Kommentar mit Grund, bei jedem Rebase aktualisiert
```

Der Job läuft nur, wenn der PR von Dependabot stammt **und** Dependabot den Lauf ausgelöst hat. Pusht ein Mensch zusätzlich auf den Branch, wird nicht automatisch gemergt.

### Einbinden in ein Repo

1. **`.github/dependabot.yml`** aus [`templates/dependabot.yml`](templates/dependabot.yml) übernehmen. Repo-spezifisch bleiben nur `registries` und `ignore`, jeweils mit Grund.
2. **CI**: Am Ende der CI-Datei kommen die beiden Jobs `ci` und `dependabot` aus [`templates/ci.yml`](templates/ci.yml) dazu. `ci` braucht in `needs` alle anderen Jobs der Datei.
3. **Eigene Auto-Merge-Workflows löschen** (`dependabot-auto-merge.yml` und ähnliche).
4. **Branch-Schutz** setzen: `node scripts/branch-protection.mjs supsign/<repo>`, prüfen, dann mit `--apply`.

Mehr Stellschrauben gibt es bewusst nicht:

| Input | Standard | Wann ändern |
|---|---|---|
| `max-update` | `minor` | `patch`, wenn die Tests eines Repos für Minor-Updates nachweislich nicht reichen. Mit Grund im Kommentar. |
| `merge-method` | `squash` | Wenn das Repo kein Squash erlaubt, z.B. nur Merge-Commits: `merge`. |

Repo-eigene Prüfungen, etwa ein ES-Syntax-Gate für alte Display-Browser, gehören als Job in die CI des Repos und damit unter `ci`.

### Warum so

- **`needs: ci` statt `gh pr merge --auto`.** Auto-Merge braucht Branch-Schutz mit Required Check. Ohne ihn wird sofort gemergt oder GitHub lehnt ab („Protected branch rules not configured“). Ist der PR schon mergebar, scheitert das Aktivieren ebenfalls („unstable status“), und bei zwei Pflicht-Reviews wartet Auto-Merge ewig. Beides ist bei uns passiert. Mit `needs` startet der Merge erst nach grüner CI. Das funktioniert mit und ohne Branch-Schutz und braucht keine Warteschleifen.
- **REST-Merge mit `sha`.** Gemergt wird genau der Commit, den die CI geprüft hat. `gh pr merge` verweigert bei Status BLOCKED schon im Client, auch wenn der Bypass greifen würde.
- **patch und minor in getrennten Gruppen.** Ein kaputtes Minor hält die Patches nicht auf. Außerdem meldet `fetch-metadata` pro PR nur das höchste Update.
- **Ein Kommentar pro PR, aktualisiert statt neu.** Keine Kommentarflut bei Rebases.
- **Aufrufer nutzen `@main`.** Eine Änderung hier wirkt sofort in allen Repos. Deshalb nur per PR, mit grünen Tests (`node --test "actions/**/*.test.mjs"`).

Bekannte Folge: Ein Merge mit `GITHUB_TOKEN` löst keine Push-Workflows aus, `main` bekommt nach einem Dependabot-Merge also keinen eigenen CI-Lauf. Deploy-Webhooks (Forge) laufen trotzdem, sie hängen nicht an Actions.

## Branch-Schutz

Standard für den Default-Branch jedes Repos mit CI. Gesetzt wird er mit [`scripts/branch-protection.mjs`](scripts/branch-protection.mjs):

- Required-Status-Check **`ci`**, gebunden an GitHub Actions, nicht strict
- kein Force-Push, kein Löschen
- Reviews nach Team-Entscheid pro Repo (0, 1 oder 2). Sind Reviews Pflicht, bekommen die Apps `github-actions` und `dependabot` den Review-Bypass. Menschen brauchen ihre Reviews weiterhin.

Klassischer Branch-Schutz statt Ruleset, weil Rulesets GitHub Actions nicht als Bypass-Akteur akzeptieren (HTTP 422, „must be part of the ruleset source or owner organization“). Repo-eigene Rulesets mit Review- oder Check-Regeln meldet das Skript, damit sie überführt werden.
