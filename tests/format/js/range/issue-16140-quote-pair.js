// Regression: changing quote style should always update both quotes on a
// line, never split them. Line-level (not character-level) diffing ensures
// a matching quote pair is applied together when the line overlaps the user's
// range.
<<<PRETTIER_RANGE_START>>>let s = 'in range'<<<PRETTIER_RANGE_END>>>;
let t = 'out of range';
