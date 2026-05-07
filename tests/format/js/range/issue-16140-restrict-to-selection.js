// Regression: when the calculated range expands beyond the user's selection,
// formatting changes outside the original range should NOT be applied. Here
// only `let a` is in the selection, so `let  b` should keep its bad spacing
// even though both are inside the same VariableDeclaration that prettier
// extracts to format.
function f() {
<<<PRETTIER_RANGE_START>>>  let a    = 1;<<<PRETTIER_RANGE_END>>>
  let  b   = 2;
  let   c  = 3;
}
