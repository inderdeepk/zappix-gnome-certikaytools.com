# Zappix — GNOME Shell extension Makefile
# =======================================
#
# The default target is `make` → compile schemas + run every static check.
# Everything here is designed to be run repeatedly while developing:
#
#   make            compile schemas, parse-check, CSS balance, import smoke
#   make test       run the unit suites (plain gjs, no shell required)
#   make lint       ESLint (needs `npm install` once)
#   make install    copy into ~/.local/share/gnome-shell/extensions
#   make reload     disable + enable in the running shell
#   make logs       follow this extension's journal lines
#
# The extension is a client of an existing Zabbix server; it ships no server of
# its own. Connecting it to the DeliverEdge monitoring plane is a documented
# procedure, not a script — see Documentation/Help/DeliverEdge.md.

EXTENSION_DIR  := $(shell pwd)
UUID           := zappix-gnome@certikaytools.com
INSTALL_DIR    := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
PACKAGE_NAME   := $(UUID).zip
GETTEXT_DOMAIN := $(UUID)
PO_FILES       := $(wildcard po/*.po)

# Test suites are discovered, not listed, so `make test` can never drift.
TEST_FILES := $(wildcard tests/*.test.js)

# DeliverEdge integration bundle.

.PHONY: all compile-schemas check lint format format-check test test-verbose \
        pot langs package install uninstall reload logs nested settings \
        clean help

## all            : Compile schemas and run all static checks
all: compile-schemas check

## compile-schemas: Recompile the GSettings schema
compile-schemas:
	glib-compile-schemas schemas/
	@echo "[OK] GSettings schema compiled"

## check          : ES module parse + CSS delimiter balance + GJS import smoke
check:
	@echo "--- ES module syntax ---"
	@if command -v node >/dev/null 2>&1; then \
		node scripts/check-syntax.mjs || exit 1; \
	else \
		echo "[WARN] node not found — skipping JS syntax checks (install Node.js to enable)"; \
	fi
	@echo "--- CSS delimiter balance ---"
	@if command -v node >/dev/null 2>&1; then \
		node scripts/check-css.mjs || exit 1; \
	else \
		echo "[WARN] node not found — skipping CSS balance check"; \
	fi
	@echo "--- Removed shell APIs ---"
	@if command -v gjs >/dev/null 2>&1; then \
		gjs -m scripts/check-api.mjs || exit 1; \
	else \
		echo "[WARN] gjs not found — skipping removed-API check"; \
	fi
	@echo "--- GJS import smoke ---"
	@if command -v gjs >/dev/null 2>&1; then \
		gjs -m scripts/import-smoke.js || exit 1; \
	else \
		echo "[WARN] gjs not found — skipping import smoke"; \
	fi
	@echo "--- Preferences UI smoke ---"
	@if command -v gjs >/dev/null 2>&1 && [ -n "$$DISPLAY$$WAYLAND_DISPLAY" ]; then \
		GDK_BACKEND=$${GDK_BACKEND:-x11} GSETTINGS_SCHEMA_DIR=schemas \
			gjs -m scripts/prefs-smoke.js || exit 1; \
	else \
		echo "[SKIP] no display available (prefs smoke needs GTK)"; \
	fi

## lint           : Run ESLint (requires: npm install)
lint:
	npm run lint

## format         : Apply Prettier formatting (requires: npm install)
format:
	npm run format

## format-check   : Verify Prettier formatting without writing
format-check:
	npm run format:check

## test           : Run every unit suite in parallel (discovered from tests/*.test.js)
test:
	@if command -v node >/dev/null 2>&1; then \
		node scripts/run-tests.mjs; \
	else \
		echo "=== Unit tests (sequential fallback): $(words $(TEST_FILES)) suites ==="; \
		for f in $(TEST_FILES); do \
			echo "--- Running $$f ---"; \
			gjs -m $$f || exit 1; \
		done; \
		echo "[OK] All tests passed"; \
	fi

## test-verbose   : Run every unit suite with per-suite output
test-verbose:
	@if command -v node >/dev/null 2>&1; then \
		node scripts/run-tests.mjs --verbose; \
	else \
		for f in $(TEST_FILES); do echo "--- $$f ---"; gjs -m $$f || true; done; \
	fi

## pot            : Regenerate the translation template (no-op until po/ exists)
pot:
	@mkdir -p po
	@if command -v xgettext >/dev/null 2>&1; then \
		xgettext --from-code=UTF-8 --language=JavaScript \
			--keyword=gettext --keyword=_ --keyword=ngettext:1,2 \
			--keyword=format \
			--output=po/$(GETTEXT_DOMAIN).pot \
			$$(find . -name '*.js' -not -path './node_modules/*' -not -path './tests/*'); \
		echo "[OK] POT updated"; \
	else \
		echo "[SKIP] xgettext not installed"; \
	fi

## langs          : Compile po/*.po into locale/<lang>/LC_MESSAGES/$(UUID).mo
langs:
	@if [ -z "$(PO_FILES)" ]; then echo "[SKIP] No po/*.po files yet"; exit 0; fi
	@for po in $(PO_FILES); do \
		lang=$$(basename $$po .po); \
		mkdir -p locale/$$lang/LC_MESSAGES; \
		msgfmt -c -o locale/$$lang/LC_MESSAGES/$(GETTEXT_DOMAIN).mo $$po; \
		echo "[OK] $$lang"; \
	done

## package        : Build a distributable .zip for extensions.gnome.org
package: compile-schemas
	@rm -f $(PACKAGE_NAME)
	@locale_arg=""; [ -d locale ] && locale_arg="locale/"; \
	zip -r $(PACKAGE_NAME) \
		extension.js prefs.js metadata.json stylesheet.css prefs.css \
		schemas/ icons/ src/ $$locale_arg \
		-x "*.git*" "*.swp" "*.zip" "schemas/*~" "*__pycache__*"
	@echo "[OK] Package created: $(PACKAGE_NAME)"

## install        : Copy the extension into the local GNOME extensions directory
install: compile-schemas
	@if [ "$(EXTENSION_DIR)" = "$(INSTALL_DIR)" ]; then \
		echo "[OK] Already in the extensions directory — schemas compiled, nothing to copy"; \
		echo "     Reload with: make reload"; \
	else \
		mkdir -p $(INSTALL_DIR); \
		rsync -a --delete \
			--exclude='.git' --exclude='.vscode' --exclude='node_modules' \
			--exclude='*.zip' --exclude='*.swp' --exclude='debug' \
			./ $(INSTALL_DIR)/; \
		echo "[OK] Installed to $(INSTALL_DIR)"; \
	fi

## uninstall      : Remove the extension from the user's extension directory
uninstall:
	@rm -rf $(INSTALL_DIR)
	@echo "[OK] Removed $(INSTALL_DIR)"

## reload         : Re-run enable() (does NOT reload changed JS — see restart)
reload:
	@gnome-extensions disable $(UUID) 2>/dev/null || true
	@gnome-extensions enable $(UUID)
	@echo "[OK] enable() re-ran — follow logs with: make logs"
	@echo "     NOTE: GNOME 45+ caches the JavaScript modules, so edits are NOT"
	@echo "     picked up by a reload. Use 'make restart' after changing code."

## restart        : How to actually load changed JS (the shell caches modules)
restart:
	@echo "GNOME Shell caches extension modules for the life of the session."
	@echo "To load changed code:"
	@echo "  X11      : Alt+F2, type  r , press Enter"
	@echo "  Wayland  : log out and back in" 

## logs           : Follow journal lines emitted by this extension
# `journalctl -f` needs inotify watch descriptors. On a machine with a large
# journal and the default `fs.inotify.max_user_watches` it prints "Insufficient
# watch descriptors", stops following, and the pipeline exits non-zero — which
# used to abort `make`. The `|| true` keeps Ctrl-C and that case quiet.
logs:
	@journalctl --no-pager -f -o cat /usr/bin/gnome-shell 2>/dev/null \
		| grep --line-buffered -i "zappix" || true

## logs-all       : Follow every journal line, unfiltered
logs-all:
	@journalctl --no-pager -f -o cat || true

## prefs          : Run preferences in this terminal (shows save/keyring errors)
# The preferences window is a separate process: opened from the dropdown its
# warnings go nowhere, so run it here when a save misbehaves.
prefs:
	gnome-extensions prefs $(UUID)

## nested         : Run a nested GNOME Shell session for safe iteration
nested:
	dbus-run-session -- gnome-shell --nested --wayland

## settings       : Open the preferences window
settings:
	gnome-extensions prefs $(UUID)

## clean          : Remove build artifacts
clean:
	rm -f $(PACKAGE_NAME)
	rm -rf locale
	@find . -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
	@echo "[OK] Cleaned"

## help           : Show this help
help:
	@grep '^##' Makefile | sed 's/## /  /'
