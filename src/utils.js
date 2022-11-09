class Params {
    source = "./";
    destination = null;
    logErrors = false;
    packages = []

    static args = new Map([
        ['--source', 'source'],
        ['--destination', 'destination'],
        ['--logErrors', 'logErrors'],
        ['--packages', 'packages'],
    ])

    constructor(packages, source, destination, logErrors) {
        [this.source, this.destination, this.packages, this.logErrors] = [source, destination, packages, logErrors];
    }
}

class PackageList {
    list = [];
    constructor(init) {
        if (init === undefined) return;
        if (!Array.isArray(init)) throw new Error("PackageList constructor receives array of initial values")
        init.map(el => this.add(el));
    }
    names() {
        return this.list.map(el => el.name);
    }
    values() {
        return this.list;
    }
    add(val) {
        if (!Array.isArray(val)) val = [val]
        const names = this.names();
        val.map(el => {
            if (names.includes(el.name)) return;
            this.list.push(el);
        })

        return this.list
    }

    contains(val) {
        return this.list.map(el => el.name).includes(val);
    }
    size() {
        return this.list.length;
    }
}

function isWindows () {
    return !!process.platform.match('win32')
}

module.exports.Params = Params
module.exports.PackageList = PackageList
module.exports.isWindows = isWindows