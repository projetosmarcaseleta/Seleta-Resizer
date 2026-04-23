async function testFreeImageHostMultipart() {
  const fd = new FormData();
  fd.append('key', '6d207e02198a847aa98d0a2a901485a5');
  fd.append('action', 'upload');
  
  const base64Data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAXSURBVBhXY/iPAQAFAAIBAD4v1rQAAAAASUVORK5CYII=';
  const buffer = Buffer.from(base64Data, 'base64');
  const blob = new Blob([buffer], { type: 'image/png' });
  
  fd.append('source', blob, 'test.png');
  fd.append('format', 'json');

  try {
    const r = await fetch('https://freeimage.host/api/1/upload', {
      method: 'POST',
      body: fd,
      headers: { 'Origin': 'null' }
    });
    const json = await r.json();
    console.log('Result:', json);
  } catch (e) { console.error(e); }
}

testFreeImageHostMultipart();
