<?php
/**
 * Router pre lokálny beh PHP verzie cez vstavaný server:
 *
 *   php -S localhost:8090 -t public router.php
 *
 * Simuluje .htaccess pravidlo (/api/* -> api.php), ktoré na hostingu
 * zabezpečuje Apache. Na produkcii tento súbor netreba nahrávať.
 */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/#', $path)) {
    require $_SERVER['DOCUMENT_ROOT'] . '/api.php';
    return true;
}
return false; // statické súbory obslúži vstavaný server
