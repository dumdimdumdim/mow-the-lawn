# Mow the Lawn

Небольшая браузерная игра про стрижку газона. Стрелки или WASD управляют косилкой. На сенсорном экране доступны экранные кнопки.

Косилка мягко выравнивается по невидимым направляющим, когда движется почти прямо вдоль или поперёк участка. Срез остаётся на газоне, а полевые цветы исчезают под ножом.

## Локальный запуск

В корне репозитория запустите `python3 -m http.server 8000` и откройте [игру](http://localhost:8000/prototype/index.html).

## Сторонние материалы

- [Three.js r170](https://github.com/mrdoob/three.js/tree/r170) распространяется по [лицензии MIT](vendor/three/LICENSE).
- Клипы ходьбы взяты из [Quaternius Universal Animation Library 2](https://quaternius.com/packs/universalanimationlibrary2.html), CC0. Исходные клипы и извлечённые траектории находятся в `prototype/assets/motion/`.
