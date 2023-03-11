#!/usr/bin/env -S deno run
const table = `
1	:authority
2	:method	GET
3	:method	POST
4	:path	/
5	:path	/index.html
6	:scheme	http
7	:scheme	https
8	:status	200
9	:status	204
10	:status	206
11	:status	304
12	:status	400
13	:status	404
14	:status	500
15	accept-charset
16	accept-encoding	gzip, deflate
17	accept-language
18	accept-ranges
19	accept
20	access-control-allow-origin
21	age
22	allow
23	authorization
24	cache-control
25	content-disposition
26	content-encoding
27	content-language
28	content-length
29	content-location
30	content-range
31	content-type
32	cookie
33	date
34	etag
35	expect
36	expires
37	from
38	host
39	if-match
40	if-modified-since
41	if-none-match
42	if-range
43	if-unmodified-since
44	last-modified
45	link
46	location
47	max-forwards
48	proxy-authenticate
49	proxy-authorization
50	range
51	referer
52	refresh
53	retry-after
54	server
55	set-cookie
56	strict-transport-security
57	transfer-encoding
58	user-agent
59	vary
60	via
61	www-authenticate
`;

const out: Array<{name: string, value: string, nameSize: number, totalSize: number}> = [];
table.split('\n').filter(function(line) {
  return line;
}).forEach(function(line) {
  const columns = line.split(/\t/g);
  const name = columns[1];
  const value = columns[2] || '';
  const nameSize = new TextEncoder().encode(name).byteLength;
  const valueSize = new TextEncoder().encode(value).byteLength;
  out.push({
    name: name,
    value: value,
    nameSize: nameSize,
    totalSize: nameSize + valueSize + 32
  });
});

console.log('export const table = ' + JSON.stringify(out, null, 2) + ';');

const map: Record<string,{index: number, values: Record<string,number>}> = {};
table.split('\n').filter(function(line) {
  return line;
}).forEach(function(line) {
  const columns = line.split(/\t/g);
  const name = columns[1];
  const value = columns[2] || '';

  const index = parseInt(columns[0]);
  if (!map[name]) {
    map[name] = {
      index: index,
      values: {}
    };
  }
  map[name].values[value] = index;
});
console.log('type StaticTableMap = Record<string, {index: number, values: Record<string,number|undefined>}|undefined>;')
console.log('export const map: StaticTableMap = ' + JSON.stringify(map, null, 2) + ';\n');
console.log('export const staticTable = {\n  table,\n  map,\n}')
