import { useEffect, useId, useRef, useState } from "react";

/**
 * A searchable, browsable picker that still accepts anything typed.
 *
 * This replaces `<input list>` with a `<datalist>`, which looked right and was
 * unusable: browsers only surface datalist suggestions once you start typing,
 * offer no affordance that a list exists at all, and give no way to simply
 * BROWSE the options. Picking an accessory you half-remember the name of was
 * therefore impossible — the one thing the control was for.
 *
 * A plain `<select>` would fix browsing and break the other half: the source
 * spreadsheet let these fields be anything, and a closed list refuses every
 * movement the catalogue has not seen yet, which is every new one.
 *
 * So: an input that filters, a button that opens the full list, and free text
 * as a first-class outcome.
 */

export interface ComboboxProps {
  id: string;
  label: React.ReactNode;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}

export const Combobox = ({ id, label, value, options, onChange, placeholder }: ComboboxProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const listId = useId();

  // `query === null` means "not being edited", so the field shows the committed
  // value. Tracking them separately is what lets the list show EVERYTHING when
  // the box is opened without first clearing what is already chosen.
  const text = query ?? value;
  const filtered =
    query && query.trim() !== ""
      ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
      : options;

  useEffect(() => {
    if (!open) return;
    const onDocument = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery(null);
      }
    };
    document.addEventListener("mousedown", onDocument);
    return () => document.removeEventListener("mousedown", onDocument);
  }, [open]);

  const commit = (next: string) => {
    onChange(next);
    setQuery(null);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => {
        const next = event.key === "ArrowDown" ? i + 1 : i - 1;
        return Math.max(0, Math.min(filtered.length - 1, next));
      });
      return;
    }
    if (event.key === "Enter" && open && filtered[active]) {
      event.preventDefault();
      commit(filtered[active]);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setQuery(null);
    }
  };

  return (
    <div className="field combobox" ref={wrapper}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="combobox__control">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
            // Typed text commits immediately, so a name that is not in the list
            // is kept rather than lost when focus moves elsewhere.
            onChange(e.target.value);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="combobox__toggle"
          aria-label={open ? "Hide options" : "Show all options"}
          onClick={() => {
            // Clearing the query is what makes this a BROWSE rather than a
            // filtered re-open: the whole list, regardless of what is chosen.
            setQuery(open ? null : "");
            setOpen(!open);
          }}
        >
          <span aria-hidden="true">▾</span>
        </button>
      </div>

      {/* Plain divs, not a ul/li/button tree. A list element carrying
          role="listbox" fights its own native semantics, and a button with
          role="option" claims to be two things at once. A div has no semantics
          to override, so the ARIA roles are the only ones in play. */}
      {open && (
        <div className="combobox__list" id={listId} role="listbox" aria-label="Options">
          {filtered.length === 0 ? (
            <p className="combobox__empty muted">No match — “{text}” will be used as typed.</p>
          ) : (
            filtered.slice(0, 200).map((option, i) => (
              <div
                key={option}
                role="option"
                tabIndex={-1}
                aria-selected={option === value}
                className={`combobox__option${i === active ? " combobox__option--active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(option)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") commit(option);
                }}
              >
                {option}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
