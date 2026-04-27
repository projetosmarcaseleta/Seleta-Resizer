
function getPathname(url) {
  let pathname = url.split('?')[0];
  if (pathname.startsWith('/resizer')) {
    pathname = pathname.slice(8) || '/';
  }
  pathname = pathname.replace(/\/+/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

const tests = [
  '/api/processar',
  '/resizer/api/processar',
  '/resizer/api/processar/',
  '//api/processar',
  '/api/processar?token=123',
  '/resizer/api/processar?token=123'
];

tests.forEach(t => {
  console.log(`URL: ${t.padEnd(35)} -> Pathname: ${getPathname(t)}`);
});
