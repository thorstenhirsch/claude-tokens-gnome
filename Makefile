UUID     := claude-tokens@maki
DESTDIR  := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMAS  := schemas

.PHONY: all install uninstall schemas pack clean enable disable restart-shell

all: schemas

# ── Compile GSettings schema ──────────────────────────────────────────────────
schemas:
	glib-compile-schemas $(SCHEMAS)/

# ── Install into the user extension directory ─────────────────────────────────
install: schemas
	@echo "Installing to $(DESTDIR) …"
	@mkdir -p "$(DESTDIR)/schemas"
	@cp metadata.json extension.js prefs.js stylesheet.css "$(DESTDIR)/"
	@cp $(SCHEMAS)/org.gnome.shell.extensions.claude-tokens.gschema.xml "$(DESTDIR)/schemas/"
	@cp $(SCHEMAS)/gschemas.compiled "$(DESTDIR)/schemas/"
	@echo "Done. Restart GNOME Shell (Alt+F2 → r) or log out/in, then enable the extension."

# ── Uninstall ─────────────────────────────────────────────────────────────────
uninstall:
	@echo "Removing $(DESTDIR) …"
	@rm -rf "$(DESTDIR)"
	@echo "Done."

# ── Enable / disable via gnome-extensions CLI ─────────────────────────────────
enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# ── Restart GNOME Shell (X11 only) ───────────────────────────────────────────
restart-shell:
	@echo "Restarting GNOME Shell (X11 only)…"
	busctl --user call org.gnome.Shell /org/gnome/Shell org.gnome.Shell Eval s 'Meta.restart("Restarting…", global.context)'

# ── Create distributable zip ──────────────────────────────────────────────────
pack: schemas
	@echo "Packaging $(UUID).zip …"
	@zip -r "$(UUID).zip" \
		metadata.json \
		extension.js \
		prefs.js \
		stylesheet.css \
		$(SCHEMAS)/org.gnome.shell.extensions.claude-tokens.gschema.xml \
		$(SCHEMAS)/gschemas.compiled
	@echo "Created $(UUID).zip"

clean:
	@rm -f $(SCHEMAS)/gschemas.compiled
	@rm -f $(UUID).zip
