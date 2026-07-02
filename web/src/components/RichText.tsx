import { Children, cloneElement, Fragment, isValidElement, type ReactNode } from "react";

type RichTextProps = {
  text: string;
  className?: string;
  inline?: boolean;
  title?: string;
};

type TextSegment =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };

const COMMAND_REPLACEMENTS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  Lambda: "Λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  Xi: "Ξ",
  pi: "π",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  Phi: "Φ",
  chi: "χ",
  psi: "ψ",
  Psi: "Ψ",
  omega: "ω",
  Omega: "Ω",
  times: "×",
  cdot: "·",
  pm: "±",
  mp: "∓",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  simeq: "≃",
  equiv: "≡",
  propto: "∝",
  sim: "∼",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  int: "∫",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  Leftrightarrow: "⇔",
  leftrightarrow: "↔",
  longrightarrow: "⟶",
  Longrightarrow: "⟹",
  degree: "°",
  circ: "°",
  div: "÷"
};

export function RichText({ text, className, inline = false, title }: RichTextProps) {
  const Tag = inline ? "span" : "div";
  return (
    <Tag className={className} title={title}>
      <RichTextFragment text={text} />
    </Tag>
  );
}

export function RichTextFragment({ text }: { text: string }) {
  return <>{splitTextAndMath(text).map((segment, index) => renderSegment(segment, index))}</>;
}

export function renderRichTextChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <RichTextFragment text={child} />;
    }
    if (!isValidElement<{ children?: ReactNode }>(child)) {
      return child;
    }
    if (typeof child.type === "string" && ["code", "pre", "script", "style", "textarea"].includes(child.type)) {
      return child;
    }
    if (child.props.children === undefined) {
      return child;
    }
    return cloneElement(child, {
      children: renderRichTextChildren(child.props.children)
    });
  });
}

function renderSegment(segment: TextSegment, index: number) {
  if (segment.type === "text") {
    return <Fragment key={index}>{unescapePlainText(segment.value)}</Fragment>;
  }
  return (
    <Formula key={index} source={segment.value} display={segment.display} />
  );
}

function splitTextAndMath(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = findNextMathStart(text, cursor);
    if (!next) {
      segments.push({ type: "text", value: text.slice(cursor) });
      break;
    }
    if (next.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, next.index) });
    }
    const close = findClosingDelimiter(text, next.contentStart, next.close, next.allowEscapedDollarClose);
    if (!close) {
      segments.push({ type: "text", value: text.slice(next.index, next.contentStart) });
      cursor = next.contentStart;
      continue;
    }
    segments.push({
      type: "math",
      value: text.slice(next.contentStart, close.index),
      display: next.display
    });
    cursor = close.index + close.length;
  }
  return mergeTextSegments(segments);
}

type MathStart = {
  index: number;
  contentStart: number;
  close: string;
  display: boolean;
  allowEscapedDollarClose?: boolean;
};

function findNextMathStart(text: string, from: number): MathStart | null {
  for (let i = from; i < text.length; i += 1) {
    // Some imported JSON/Markdown escapes dollar delimiters as \$...$ or \$...\$.
    // Treat those as math delimiters in display fields, while still keeping ordinary
    // escaped dollars readable when there is no matching closing delimiter.
    if (text.startsWith("\\$", i) && isLikelyDollarDelimiter(text, i + 1, 1, true)) {
      return { index: i, contentStart: i + 2, close: "$", display: false, allowEscapedDollarClose: true };
    }
    if (text.startsWith("\\$$", i) && isLikelyDollarDelimiter(text, i + 1, 2, true)) {
      return { index: i, contentStart: i + 3, close: "$$", display: true, allowEscapedDollarClose: true };
    }
    if (text.startsWith("$$", i) && isLikelyDollarDelimiter(text, i, 2)) {
      return { index: i, contentStart: i + 2, close: "$$", display: true };
    }
    if (text.startsWith("\\[", i)) {
      return { index: i, contentStart: i + 2, close: "\\]", display: true };
    }
    if (text.startsWith("\\(", i)) {
      return { index: i, contentStart: i + 2, close: "\\)", display: false };
    }
    if (text[i] === "$" && isLikelyDollarDelimiter(text, i, 1)) {
      return { index: i, contentStart: i + 1, close: "$", display: false };
    }
  }
  return null;
}

function findClosingDelimiter(text: string, from: number, close: string, allowEscapedDollarClose = false) {
  if (close === "$" || close === "$$") {
    const dollarCount = close.length;
    for (let i = from; i < text.length; i += 1) {
      if (!text.startsWith(close, i)) continue;
      const escaped = text[i - 1] === "\\";
      if (!escaped) return { index: i, length: dollarCount };
      if (allowEscapedDollarClose) return { index: i - 1, length: dollarCount + 1 };
    }
    return null;
  }
  const index = text.indexOf(close, from);
  return index >= 0 ? { index, length: close.length } : null;
}

function isLikelyDollarDelimiter(text: string, index: number, length: number, allowEscapedStart = false) {
  const previous = text[index - 1];
  const next = text[index + length];
  if (previous === "\\" && !allowEscapedStart) return false;
  if (!next || /\s/.test(next)) return false;
  if (length === 1 && next === "$") return false;
  return true;
}

function mergeTextSegments(segments: TextSegment[]): TextSegment[] {
  const merged: TextSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.type === "text" && previous?.type === "text") {
      previous.value += segment.value;
    } else if (segment.value) {
      merged.push(segment);
    }
  }
  return merged;
}

function unescapePlainText(value: string) {
  return value.replace(/\\\$/g, "$");
}

function Formula({ source, display }: { source: string; display: boolean }) {
  return (
    <span className={display ? "chem-formula chem-formula-block" : "chem-formula chem-formula-inline"} title={source.trim()}>
      {renderMathExpression(source.trim())}
    </span>
  );
}

function renderMathExpression(source: string): ReactNode[] {
  const normalized = source.replace(/\s+/g, " ");
  return parseMath(normalized, 0, normalized.length).nodes;
}

function parseMath(source: string, start: number, end: number): { nodes: ReactNode[]; index: number } {
  const nodes: ReactNode[] = [];
  let i = start;
  while (i < end) {
    const char = source[i];
    if (char === "\\") {
      const parsed = parseCommand(source, i, end);
      nodes.push(parsed.node);
      i = parsed.index;
      continue;
    }
    if (char === "^" || char === "_") {
      const parsed = parseScript(source, i + 1, end, char === "^" ? "sup" : "sub");
      nodes.push(parsed.node);
      i = parsed.index;
      continue;
    }
    if (char === "{") {
      const group = readBraceGroup(source, i, end);
      if (group) {
        nodes.push(<Fragment key={nodes.length}>{parseMath(group.value, 0, group.value.length).nodes}</Fragment>);
        i = group.index;
        continue;
      }
    }
    if (char === "}") {
      break;
    }
    nodes.push(<Fragment key={nodes.length}>{char}</Fragment>);
    i += 1;
  }
  return { nodes, index: i };
}

function parseCommand(source: string, index: number, end: number): { node: ReactNode; index: number } {
  let i = index + 1;
  if (i >= end) return { node: "\\", index: i };

  const single = source[i];
  if (single === ",") return { node: <span key={index} className="chem-formula-thin-space" />, index: i + 1 };
  if (single === ";" || single === " ") return { node: " ", index: i + 1 };
  if (single === "%") return { node: "%", index: i + 1 };
  if (single === "&") return { node: "&", index: i + 1 };
  if (single === "_") return { node: "_", index: i + 1 };

  while (i < end && /[A-Za-z]/.test(source[i])) i += 1;
  const command = source.slice(index + 1, i);

  if (command === "left" || command === "right" || command === "big" || command === "Big" || command === "bigl" || command === "bigr" || command === "Bigl" || command === "Bigr") {
    const j = skipSpaces(source, i, end);
    if (j < end) {
      return { node: source[j] === "." ? "" : source[j], index: j + 1 };
    }
    return { node: "", index: i };
  }

  if (command === "quad") return { node: <span key={index} className="chem-formula-quad-space" />, index: i };
  if (command === "qquad") return { node: <span key={index} className="chem-formula-qquad-space" />, index: i };

  if (["sin", "cos", "tan", "log", "ln", "exp", "min", "max", "lim"].includes(command)) {
    return { node: <span key={index} className="chem-formula-roman">{command}</span>, index: i };
  }

  if (command === "frac") {
    const numerator = readBraceGroupSkippingSpace(source, i, end);
    const denominator = numerator ? readBraceGroupSkippingSpace(source, numerator.index, end) : null;
    if (numerator && denominator) {
      return {
        node: (
          <span key={index} className="chem-formula-frac">
            <span className="chem-formula-frac-num">{parseMath(numerator.value, 0, numerator.value.length).nodes}</span>
            <span className="chem-formula-frac-den">{parseMath(denominator.value, 0, denominator.value.length).nodes}</span>
          </span>
        ),
        index: denominator.index
      };
    }
  }

  if (command === "sqrt") {
    const radicand = readBraceGroupSkippingSpace(source, i, end);
    if (radicand) {
      return {
        node: <span key={index} className="chem-formula-sqrt">√<span>{parseMath(radicand.value, 0, radicand.value.length).nodes}</span></span>,
        index: radicand.index
      };
    }
  }

  if (isTextLikeCommand(command)) {
    const group = readBraceGroupSkippingSpace(source, i, end);
    if (group) {
      return {
        node: <span key={index} className={mathCommandClassName(command)}>{renderCommandGroup(command, group.value)}</span>,
        index: group.index
      };
    }
  }

  if (command === "overline" || command === "bar") {
    const group = readBraceGroupSkippingSpace(source, i, end);
    if (group) {
      return {
        node: <span key={index} className="chem-formula-overline">{parseMath(group.value, 0, group.value.length).nodes}</span>,
        index: group.index
      };
    }
  }

  const replacement = COMMAND_REPLACEMENTS[command];
  if (replacement) {
    return { node: <span key={index} className="chem-formula-symbol">{replacement}</span>, index: i };
  }
  if (command.length > 0) {
    return { node: <span key={index}>{command}</span>, index: i };
  }
  return { node: single, index: i + 1 };
}

function parseScript(source: string, index: number, end: number, type: "sup" | "sub"): { node: ReactNode; index: number } {
  let i = skipSpaces(source, index, end);
  let value = "";
  if (source[i] === "{") {
    const group = readBraceGroup(source, i, end);
    if (group) {
      value = group.value;
      i = group.index;
    }
  } else if (i < end) {
    value = source[i];
    i += 1;
  }
  const Tag = type;
  return {
    node: <Tag key={`${type}-${index}`} className={type === "sup" ? "chem-formula-sup" : "chem-formula-sub"}>{parseMath(value, 0, value.length).nodes}</Tag>,
    index: i
  };
}


function isTextLikeCommand(command: string) {
  return [
    "mathrm",
    "mathtrm",
    "textrm",
    "text",
    "operatorname",
    "mathbf",
    "boldsymbol",
    "textbf",
    "mathit",
    "textit",
    "mathsf",
    "mathtt",
    "mathcal",
    "ce"
  ].includes(command);
}

function mathCommandClassName(command: string) {
  if (command === "mathbf" || command === "boldsymbol" || command === "textbf") return "chem-formula-bold";
  if (command === "mathit" || command === "textit") return "chem-formula-italic";
  if (command === "mathsf") return "chem-formula-sans";
  if (command === "mathtt") return "chem-formula-mono";
  if (command === "mathcal") return "chem-formula-cal";
  return "chem-formula-roman";
}

function renderCommandGroup(command: string, value: string) {
  if (command === "text" || command === "operatorname" || command === "ce") return value;
  return parseMath(value, 0, value.length).nodes;
}

function readBraceGroupSkippingSpace(source: string, index: number, end: number) {
  return readBraceGroup(source, skipSpaces(source, index, end), end);
}

function skipSpaces(source: string, index: number, end: number) {
  let i = index;
  while (i < end && /\s/.test(source[i])) i += 1;
  return i;
}

function readBraceGroup(source: string, index: number, end: number): { value: string; index: number } | null {
  if (source[index] !== "{") return null;
  let depth = 0;
  for (let i = index; i < end; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { value: source.slice(index + 1, i), index: i + 1 };
      }
    }
  }
  return null;
}
