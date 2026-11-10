export type GradeAssignment = {
  id: string;
  canvasId: string;
  groupId: string;
  pointsPossible: number | null;
  score: number | null;
  excused?: boolean;
  omitted?: boolean;
  ungraded?: boolean;
  extraCredit?: boolean;
};

export type GradeGroup = {
  id: string;
  name: string;
  weight: number;
  dropLowest: number;
  dropHighest: number;
  neverDropCanvasIds: string[];
};

export type GradeCalculation = {
  percent: number | null;
  earned: number;
  possible: number;
  groups: Array<{
    id: string;
    name: string;
    weight: number;
    earned: number;
    possible: number;
    percent: number | null;
    droppedAssignmentIds: string[];
  }>;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function scoreFor(assignment: GradeAssignment, hypothetical: Record<string, number | null>) {
  const override = hypothetical[assignment.id];
  if (finite(override)) return override;
  return assignment.score;
}

function droppedIds(group: GradeGroup, candidates: Array<{ assignment: GradeAssignment; score: number }>) {
  const never = new Set(group.neverDropCanvasIds);
  const sortable = candidates.filter(({ assignment }) =>
    !never.has(assignment.canvasId) && finite(assignment.pointsPossible) && (assignment.pointsPossible ?? 0) > 0);
  sortable.sort((a, b) => (a.score / (a.assignment.pointsPossible ?? 1)) - (b.score / (b.assignment.pointsPossible ?? 1)) || a.assignment.id.localeCompare(b.assignment.id));
  const result = new Set<string>();
  for (const item of sortable.slice(0, Math.max(0, group.dropLowest))) result.add(item.assignment.id);
  const remaining = sortable.filter((item) => !result.has(item.assignment.id));
  for (const item of remaining.slice(Math.max(0, remaining.length - Math.max(0, group.dropHighest)))) result.add(item.assignment.id);
  return result;
}

/**
 * Pure local Canvas-style what-if calculator. It never calls Canvas and never
 * persists answer or quiz data. Excused/omitted/ungraded work is excluded;
 * zero-point extra credit raises the numerator without raising the denominator.
 */
export function calculateGrade(input: {
  weighted: boolean;
  groups: GradeGroup[];
  assignments: GradeAssignment[];
  hypothetical?: Record<string, number | null>;
}): GradeCalculation {
  const hypothetical = input.hypothetical ?? {};
  const groups = input.groups.map((group) => {
    const candidates = input.assignments.flatMap((assignment) => {
      if (assignment.groupId !== group.id || assignment.excused || assignment.omitted || assignment.ungraded) return [];
      const score = scoreFor(assignment, hypothetical);
      return finite(score) ? [{ assignment, score }] : [];
    });
    const dropped = droppedIds(group, candidates);
    let earned = 0; let possible = 0;
    for (const { assignment, score } of candidates) {
      if (dropped.has(assignment.id)) continue;
      earned += score;
      const denominator = assignment.pointsPossible ?? 0;
      if (!assignment.extraCredit && denominator > 0) possible += denominator;
    }
    return {
      id: group.id, name: group.name, weight: finite(group.weight) ? group.weight : 0,
      earned: round(earned), possible: round(possible),
      percent: possible > 0 ? round((earned / possible) * 100) : null,
      droppedAssignmentIds: [...dropped],
    };
  });
  const earned = round(groups.reduce((sum, group) => sum + group.earned, 0));
  const possible = round(groups.reduce((sum, group) => sum + group.possible, 0));
  if (!input.weighted) return { earned, possible, percent: possible > 0 ? round((earned / possible) * 100) : null, groups };
  const active = groups.filter((group) => group.percent != null && group.weight > 0);
  const activeWeight = active.reduce((sum, group) => sum + group.weight, 0);
  const percent = activeWeight > 0
    ? round(active.reduce((sum, group) => sum + (group.percent ?? 0) * group.weight, 0) / activeWeight)
    : null;
  return { earned, possible, percent, groups };
}

export function validateHypotheticalScores(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SCORES");
  const output: Record<string, number | null> = {};
  for (const [id, score] of Object.entries(value)) {
    if (!/^[0-9a-f-]{36}$/i.test(id) || (score !== null && (!finite(score) || score < 0 || score > 1_000_000))) throw new Error("INVALID_SCORES");
    output[id] = score;
  }
  return output;
}
