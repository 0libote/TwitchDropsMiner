/**
 * Game picker: a combobox over the games the miner has discovered.
 *
 * Keyboard contract: type to filter, ArrowDown/ArrowUp to move, Enter to add
 * the highlighted (or exact) match, Escape to dismiss.
 */

import {useEffect, useRef, useState, type KeyboardEvent} from "react";
import {Button} from "@astryxdesign/core/Button";
import {useStore} from "../core/store";
import {cx} from "../core/util";

export interface GamePickerProps {
  listName: "priority" | "exclude";
  placeholder: string;
  onAdd: (game: string) => void;
  onRequestClose?: () => void;
}

export function GamePicker({listName, placeholder, onAdd}: GamePickerProps) {
  const {state, settings} = useStore();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = new Set(listName === "priority" ? settings.priority : settings.exclude);
  const needle = query.trim().toLocaleLowerCase();
  const matches = state.games
    .filter((game) => !selected.has(game) && (!needle || game.toLocaleLowerCase().includes(needle)))
    .slice(0, 8);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const add = (game?: string) => {
    const chosen = game ?? (state.games.includes(query) ? query : matches[active]);
    if (!chosen) return;
    onAdd(chosen);
    setQuery("");
    setActive(0);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (!matches.length) return;
    if (event.key === "Enter") {
      add();
      return;
    }
    if (event.key === "ArrowDown") setActive((current) => (current + 1) % matches.length);
    else setActive((current) => (current - 1 + matches.length) % matches.length);
    setOpen(true);
  };

  const canAdd = state.games.includes(query) && !selected.has(query);

  return (
    <div className="add-row">
      <div className="game-picker" ref={containerRef}>
        <input
          id={`${listName}-game`}
          className="input"
          type="search"
          role="combobox"
          aria-label={listName === "priority" ? "Add a priority game" : "Exclude a game"}
          aria-autocomplete="list"
          aria-controls={`${listName}-options`}
          aria-expanded={open}
          aria-activedescendant={open && matches.length ? `${listName}-option-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <div
          id={`${listName}-options`}
          role="listbox"
          className={cx("game-options", !open && "hidden")}
        >
          {matches.length ? (
            matches.map((game, index) => (
              <button
                key={game}
                id={`${listName}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className={cx("game-option", index === active && "active")}
                onMouseEnter={() => setActive(index)}
                onClick={() => add(game)}
              >
                {game}
              </button>
            ))
          ) : (
            <p>No matching games</p>
          )}
        </div>
      </div>
      <Button
        variant="secondary"
        type="button"
        data-add-list={listName}
        isDisabled={!canAdd}
        label="Add"
        onClick={() => add()}
      />
    </div>
  );
}
