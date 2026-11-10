import assert from "node:assert/strict";
import test from "node:test";
import { calculateGrade, validateHypotheticalScores } from "../lib/grades/engine";

test("weighted groups renormalize active weights and apply drop-lowest", () => {
  const result = calculateGrade({
    weighted: true,
    groups: [
      { id: "g1", name: "Quizzes", weight: 60, dropLowest: 1, dropHighest: 0, neverDropCanvasIds: [] },
      { id: "g2", name: "Project", weight: 40, dropLowest: 0, dropHighest: 0, neverDropCanvasIds: [] },
    ],
    assignments: [
      { id: "a1", canvasId: "1", groupId: "g1", pointsPossible: 10, score: 5 },
      { id: "a2", canvasId: "2", groupId: "g1", pointsPossible: 20, score: 20 },
      { id: "a3", canvasId: "3", groupId: "g2", pointsPossible: 100, score: 80 },
    ],
  });
  assert.equal(result.percent, 92);
  assert.deepEqual(result.groups[0].droppedAssignmentIds, ["a1"]);
});

test("excused, omitted and ungraded work do not enter current denominator; extra credit can exceed 100", () => {
  const result = calculateGrade({
    weighted: false,
    groups: [{ id: "g", name: "Points", weight: 0, dropLowest: 0, dropHighest: 0, neverDropCanvasIds: [] }],
    assignments: [
      { id: "graded", canvasId: "1", groupId: "g", pointsPossible: 100, score: 100 },
      { id: "extra", canvasId: "2", groupId: "g", pointsPossible: 0, score: 5, extraCredit: true },
      { id: "excused", canvasId: "3", groupId: "g", pointsPossible: 20, score: 0, excused: true },
      { id: "omitted", canvasId: "4", groupId: "g", pointsPossible: 20, score: 0, omitted: true },
      { id: "future", canvasId: "5", groupId: "g", pointsPossible: 20, score: null, ungraded: true },
    ],
  });
  assert.equal(result.percent, 105);
  assert.equal(result.possible, 100);
});

test("local hypothetical scores replace only selected assignments", () => {
  const result = calculateGrade({
    weighted: false,
    groups: [{ id: "g", name: "Points", weight: 0, dropLowest: 0, dropHighest: 0, neverDropCanvasIds: [] }],
    assignments: [{ id: "a", canvasId: "1", groupId: "g", pointsPossible: 100, score: 60 }],
    hypothetical: { a: 90 },
  });
  assert.equal(result.percent, 90);
});

test("scenario validation rejects negative and non-finite scores", () => {
  assert.throws(() => validateHypotheticalScores({ "00000000-0000-0000-0000-000000000001": -1 }), /INVALID_SCORES/);
});
