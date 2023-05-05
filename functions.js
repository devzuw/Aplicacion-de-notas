document.getElementById('almacenaje').addEventListener('submit', saveform);

function saveform(event) {
    event.preventDefault();
    let titulo = document.getElementById('titulo').value;
    let contenido = document.getElementById('content').value;
    const task = {
        titulo,
        contenido
    };
    let tasks = JSON.parse(localStorage.getItem('tasks')) || [];
    tasks.push(task);
    localStorage.setItem('tasks', JSON.stringify(tasks));
    document.getElementById('almacenaje').reset();
    getTasks();
}

function getTasks() {
    let tasks = JSON.parse(localStorage.getItem('tasks')) || [];
    var tasksView = document.getElementById('articulos');

    tasksView.innerHTML = '';
    if (tasks.length > 0 && tasks != null) {
        for (let i = 0; i < tasks.length; i++) {
            let titulo = tasks[i].titulo;
            let contenido = tasks[i].contenido;
            tasksView.innerHTML += `
                <div class="td">
                    <h1 class="task-title"><u>${titulo}</u></h1>
                    <textarea class="task-p">${contenido}</textarea>
                    <button class="btn" onclick="delet('${titulo}')">delete</button>
                </div>
            `;
        }
    }
}

function delet(titulo) {
    let tasks = JSON.parse(localStorage.getItem('tasks'));

    for (let i = 0; i < tasks.length; i++) {
        if(tasks[i].titulo == titulo){
            tasks.splice(i, 1)
        }
    }

    localStorage.setItem('tasks', JSON.stringify(tasks));
    getTasks();
};



