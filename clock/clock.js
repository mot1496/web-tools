const time = document.getElementById('time');

function clock() {
    let now = new Date();
    time.innerHTML = now.toTimeString().substring(0, 8);
}
window.setInterval(clock, 1000);

function changeColor() {
    console.log('changeColor');
    const body = document.body;
    console.log(body);
    if (body.style.backgroundColor === 'black') {
        body.style.backgroundColor = 'white';
        body.style.color = 'black';
    } else {
        body.style.backgroundColor = 'black';
        body.style.color = 'white';
    }
}