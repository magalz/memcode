import { ArrowLeft, ArrowRight } from "lucide-react";
export function ResultPager({
  page,
  total,
  size = 8,
  change,
}: {
  page: number;
  total: number;
  size?: number;
  change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) return null;
  return (
    <div className="result-pager">
      <span>
        {page * size + 1}–{Math.min((page + 1) * size, total)} of {total}{" "}
        returned results
      </span>
      <div>
        <button
          aria-label="Previous results"
          disabled={page === 0}
          onClick={() => change(page - 1)}
        >
          <ArrowLeft size={13} />
        </button>
        <span>
          {page + 1} / {pages}
        </span>
        <button
          aria-label="Next results"
          disabled={page >= pages - 1}
          onClick={() => change(page + 1)}
        >
          <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}
