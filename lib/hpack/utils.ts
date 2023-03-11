export function assert(cond: boolean, text: string) {
  if (!cond)
    throw new Error(text);
};

export function stringify(arr: number[]) {
  var res = '';
  for (var i = 0; i < arr.length; i++)
    res += String.fromCharCode(arr[i]);
  return res;
};

export function toArray(str: string) {
  var res = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    var hi = c >>> 8;
    var lo = c & 0xff;
    if (hi)
      res.push(hi, lo);
    else
      res.push(lo);
  }
  return res;
};
