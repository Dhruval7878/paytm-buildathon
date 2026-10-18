const list = [require('./form-interviewer')];
module.exports = { list, get: id => list.find(u => u.id === id) };
