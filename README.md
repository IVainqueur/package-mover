# Package-Mover
Got no internet but want to still import NPM packages in your project? No worries. With Package-Mover you can import any package and all of its sub-dependecies from one project to any other in a matter of seconds without a shred of internet.

# Installation
To install the package you just run

```shell
npm install -g package-mover
```

**Note**: Linux users might need to use `sudo`

# Usage
To use the package simple run the command:

Usage: 
```shell
package-mover [options]
```

Options:

  `-v, --version`              Output the current version.
  
  `-s, --source=<value>`       Source folder. Can be absolute or relative path
  
  `-d, --destination=<value>`  Destination folder. Can be absolute or relative path
  
  `-p, --packages=<value...>`  The package or packages that you want to transfer
  
  `-l, --logErrors`            For logging errors. default `false`
  
  `-h, --help`                 Output usage information.
  

# N.B.
The package currently only works on `unix`-based systems, but the next release will be fully cross platform.

# Contribution
Feel free to fork the project and modify it to your liking.