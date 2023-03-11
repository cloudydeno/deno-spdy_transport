// Wrap lines after 79 chars
export function wrap(str: string) {
  var out = [];
  var pad = '    ';
  var line = pad;

  var chunks = str.split(/,/g);
  chunks.forEach(function(chunk, i) {
    var append = chunk;
    if (i !== chunks.length - 1)
      append += ',';

    if (line.length + append.length > 79) {
      out.push(line);
      line = pad;
    }
    line += append;
  });
  if (line !== pad)
    out.push(line);

  return out.join('\n');
};
