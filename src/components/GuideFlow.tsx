export function GuideFlow() {
  return (
    <svg
      className="guide-flow"
      viewBox="0 0 760 240"
      role="img"
      aria-label="Start a project, connect a worker, define an epic and write a story"
    >
      <defs>
        <pattern
          id="guide-grid"
          width="24"
          height="24"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 24 0 L 0 0 0 24"
            fill="none"
            stroke="#82baa4"
            strokeOpacity=".08"
          />
        </pattern>
        <linearGradient id="guide-light">
          <stop stopColor="#6cdcca" />
          <stop offset="1" stopColor="#bfe6d2" />
        </linearGradient>
      </defs>
      <rect width="760" height="240" rx="14" fill="#0a2119" />
      <rect width="760" height="240" rx="14" fill="url(#guide-grid)" />
      <text
        x="32"
        y="36"
        fill="#74c5ad"
        fontFamily="Inter, sans-serif"
        fontSize="9"
        letterSpacing="2"
      >
        A LITTLE STRUCTURE. A LOT OF POSSIBILITY.
      </text>
      <path
        className="guide-flow-line"
        d="M145 114 H600"
        stroke="url(#guide-light)"
        strokeWidth="1"
        fill="none"
      />
      {[
        { x: 38, title: "Your project", sub: "The code and the idea", n: "01" },
        { x: 219, title: "Your worker", sub: "Connected by you", n: "02" },
        { x: 400, title: "Your epic", sub: "One useful outcome", n: "03" },
        { x: 581, title: "Your story", sub: "A clear next step", n: "04" },
      ].map((item, index) => (
        <g
          key={item.n}
          className="guide-flow-node"
          style={{ animationDelay: index * 80 + "ms" }}
        >
          <rect
            x={item.x}
            y="74"
            width="141"
            height="92"
            rx="9"
            fill="#102e23"
            stroke="#4b8069"
            strokeOpacity=".65"
          />
          <text
            x={item.x + 16}
            y="98"
            fill="#7bd5ba"
            fontFamily="monospace"
            fontSize="9"
          >
            {item.n}
          </text>
          <text
            x={item.x + 16}
            y="123"
            fill="#eef8ee"
            fontFamily="Inter,sans-serif"
            fontSize="14"
          >
            {item.title}
          </text>
          <text
            x={item.x + 16}
            y="145"
            fill="#8eb19e"
            fontFamily="Inter,sans-serif"
            fontSize="9"
          >
            {item.sub}
          </text>
        </g>
      ))}
      <text
        x="32"
        y="210"
        fill="#7b9d8c"
        fontFamily="Inter,sans-serif"
        fontSize="10"
      >
        Start small. Review the work. Build from there.
      </text>
    </svg>
  );
}
