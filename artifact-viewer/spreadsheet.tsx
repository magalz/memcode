import { useEffect, useRef, useState } from "react";
import readXlsxFile, { readSheet } from "read-excel-file/browser";
import { selectForComment } from "./selection";
import { currentReviewTarget } from "./reveal";
function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export default function Spreadsheet({ bytes }: { bytes: ArrayBuffer }) {
  const [sheets, setSheets] = useState<string[]>([]),
    [sheet, setSheet] = useState(""),
    [rows, setRows] = useState<unknown[][]>([]),
    [error, setError] = useState(""),
    [scroll, setScroll] = useState(0),
    [selected, setSelected] = useState<[number, number]>([0, 0]),
    [extent, setExtent] = useState<[number, number]>([0, 0]),
    [loading, setLoading] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void readXlsxFile(new Blob([bytes]))
      .then((entries) => {
        if (live) {
          const names = entries.map((entry) => entry.sheet);
          setSheets(names);
          setSheet(names[0] ?? "");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [bytes]);
  useEffect(() => {
    if (!sheet) return;
    let live = true;
    setLoading(true);
    setError("");
    void readSheet(new Blob([bytes]), sheet)
      .then((result) => {
        if (live) {
          setRows(result as unknown[][]);
          setScroll(0);
          setSelected([0, 0]);
          setExtent([0, 0]);
          if (viewport.current) viewport.current.scrollTop = 0;
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [bytes, sheet]);
  const columns = Math.min(
      100,
      rows.reduce((n, row) => Math.max(n, row.length), 1),
    ),
    start = Math.max(0, Math.floor(scroll / 31) - 5),
    end = Math.min(rows.length, start + 60);
  const cell = (value: unknown) =>
    value instanceof Date
      ? value.toLocaleDateString()
      : value === null || value === undefined
        ? ""
        : String(value);
  const minRow = Math.min(selected[0], extent[0]),
    maxRow = Math.max(selected[0], extent[0]),
    minColumn = Math.min(selected[1], extent[1]),
    maxColumn = Math.max(selected[1], extent[1]);
  const range = `${columnName(minColumn)}${minRow + 1}${minRow !== maxRow || minColumn !== maxColumn ? ":" + columnName(maxColumn) + (maxRow + 1) : ""}`;
  useEffect(() => {
    const reveal = (event: Event) => {
      const ref = (event as CustomEvent).detail;
      if (ref.sheet) setSheet(ref.sheet);
      if (ref.cells) {
        const row = Number(ref.cells.match(/\d+/)?.[0] ?? 1);
        if (viewport.current)
          viewport.current.scrollTop = Math.max(0, (row - 3) * 31);
      }
    };
    window.addEventListener("memcode:reveal", reveal);
    const target = currentReviewTarget();
    if (target?.sheet && sheets.includes(target.sheet)) setSheet(target.sheet);
    return () => window.removeEventListener("memcode:reveal", reveal);
  }, [sheets]);
  useEffect(() => {
    if (!rows.length || loading) return;
    const quote = rows
      .slice(minRow, Math.min(maxRow + 1, minRow + 200))
      .map((row) =>
        Array.from({ length: maxColumn - minColumn + 1 }, (_, i) =>
          cell(row[minColumn + i]),
        ).join("\t"),
      )
      .join("\n")
      .slice(0, 4000);
    selectForComment({
      quote: quote || "(empty cells)",
      sheet,
      cells: range,
      selectionType: "cells",
    });
  }, [selected, extent, rows, sheet, loading]);
  return (
    <div className="sheet-viewer" data-sheet-name={sheet}>
      <div className="sheet-formula">
        <strong>{range}</strong>
        <span>ƒx</span>
        <output>{cell(rows[selected[0]]?.[selected[1]])}</output>
      </div>
      {error && (
        <div className="viewer-error" role="alert">
          {error}
        </div>
      )}
      <div
        className="sheet-scroll"
        ref={viewport}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        {loading ? (
          <div className="loading">Reading sheet…</div>
        ) : (
          <table className="sheet-grid">
            <thead>
              <tr>
                <th />
                <>
                  {Array.from({ length: columns }, (_, i) => (
                    <th key={i}>{columnName(i)}</th>
                  ))}
                </>
              </tr>
            </thead>
            <tbody>
              {start > 0 && (
                <tr style={{ height: start * 31 }}>
                  <td colSpan={columns + 1} />
                </tr>
              )}
              {rows.slice(start, end).map((row, index) => (
                <tr key={start + index}>
                  <th>{start + index + 1}</th>
                  {Array.from({ length: columns }, (_, column) => (
                    <td
                      data-cell-row={start + index + 1}
                      data-cell-column={column + 1}
                      key={column}
                      tabIndex={0}
                      aria-selected={
                        start + index >= minRow &&
                        start + index <= maxRow &&
                        column >= minColumn &&
                        column <= maxColumn
                      }
                      onMouseDown={(event) => {
                        if (event.button !== 0) return;
                        if (!event.shiftKey)
                          setSelected([start + index, column]);
                        setExtent([start + index, column]);
                      }}
                      onMouseEnter={(event) => {
                        if (event.buttons === 1)
                          setExtent([start + index, column]);
                      }}
                      onKeyDown={(event) => {
                        const delta: Record<string, [number, number]> = {
                          ArrowUp: [-1, 0],
                          ArrowDown: [1, 0],
                          ArrowLeft: [0, -1],
                          ArrowRight: [0, 1],
                        };
                        if (!delta[event.key]) return;
                        event.preventDefault();
                        const [dr, dc] = delta[event.key],
                          point: [number, number] = [
                            Math.max(
                              0,
                              Math.min(rows.length - 1, extent[0] + dr),
                            ),
                            Math.max(0, Math.min(columns - 1, extent[1] + dc)),
                          ];
                        if (!event.shiftKey) setSelected(point);
                        setExtent(point);
                      }}
                      className={
                        typeof row[column] === "number" ? "numeric" : ""
                      }
                    >
                      {cell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
              {end < rows.length && (
                <tr style={{ height: (rows.length - end) * 31 }}>
                  <td colSpan={columns + 1} />
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      <footer className="sheet-tabs" role="tablist" aria-label="Worksheets">
        {sheets.map((name) => (
          <button
            role="tab"
            aria-selected={sheet === name}
            key={name}
            onClick={() => setSheet(name)}
          >
            {name}
          </button>
        ))}
        <span>{rows.length.toLocaleString()} rows · stored values</span>
      </footer>
    </div>
  );
}
