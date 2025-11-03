var express = require('express'),
    router = express.Router(),
    bodyParser = require('body-parser');

router.use(bodyParser.urlencoded({ extended: true }));

router.get('/', function (req, res) {
    try{
        if(req.user.AccessType == 1){
            //Admistrator
            res.redirect('/administrator')
        }
        else if(req.user.AccessType == 2){
            //Teacher
            res.redirect('/teacher')
        }
        else if(req.user.AccessType == 3){
            //Accoutant
            res.redirect('/accountant')
        }
        else if(req.user.AccessType == 4){
            res.redirect('/student')
        }
        else{
            res.redirect('/administrator')
            // res.redirect('/logout')
        }
    }
    catch{
        res.redirect('/')
    }
})

module.exports = router;