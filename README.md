# Package-Mover
Got no internet but want to still import NPM packages in your project? No worries. With Package-Mover you can import any package and all of its sub-dependecies from one project to any other in a matter of seconds without a shred of internet.

# Installation
To install the package you just run

`npm install -g package-manager`

**Note**: Linux users might need to use `sudo`

# Usage
To use the package simple run the command:

```shell
package-mover --source=<source_dir> --destination=<destination_dir> --packages=<needed_packages> --logErrors=<true|false>
```

- `<source_dir>`: is the *relative* or *absolute* path to the project that you want to get the modules from.
- `<desination_dir>`: is the target directory into which you want to move the packages.
- `<needed_packages>`: is the **package** or **packages** that you want to move. If more than one, they are to be separated by comma. 
    eg: <br>
        ```shell
        package-mover --source=./project1 --destination=./project2 --packages=express,cors
        ```

In the above example the packages `express` and `cors` are being imported from `project1` to `project2`